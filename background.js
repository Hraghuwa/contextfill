// Runs fills so they survive the popup closing, handle the keyboard shortcut, and follow multi-page applications.
importScripts('llm.js');

const IDLE_MS = 30 * 60 * 1000;

// Ollama rejects requests carrying a browser-extension Origin (its CSRF guard). Drop that header, but only on
// this extension's own requests to a local Ollama, so web pages stay blocked as before.
const OLLAMA_RULE = {
  id: 1, priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
  condition: { requestDomains: ['localhost', '127.0.0.1'], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
};
chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [OLLAMA_RULE.id], addRules: [OLLAMA_RULE] }).catch(() => {});
const store = chrome.storage.session; // per-tab state; cleared when the browser closes
const k = (name, tabId) => `${name}:${tabId}`;
const running = new Set();

async function getTab(name, tabId) { return (await store.get(k(name, tabId)))[k(name, tabId)]; }
const setTab = (name, tabId, value) => store.set({ [k(name, tabId)]: value });

async function badge(tabId, text, color = '#f59e0b') {
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}
const showAsks = (tabId, asks) => badge(tabId, asks.length ? String(asks.length) : '');

// Field ids are "frameId:docId-n"; send each frame its own items. Returns { filled, failed: [full ids] }.
async function applyItems(tabId, items) {
  const byFrame = {};
  for (const i of items) {
    const cut = i.id.indexOf(':');
    (byFrame[i.id.slice(0, cut)] ||= []).push({ ...i, id: i.id.slice(cut + 1) });
  }
  let filled = 0;
  const failed = [];
  for (const [frameId, its] of Object.entries(byFrame)) {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [+frameId] }, func: its => window.__cf.fill(its), args: [its],
    });
    filled += r?.result?.filled || 0;
    failed.push(...(r?.result?.failed || []).map(id => `${frameId}:${id}`));
  }
  return { filled, failed };
}

// One tracker row per application: later steps of the same session update the row from its first page.
async function logApplication(appUrl, page, company, role) {
  const { applications = [] } = await chrome.storage.local.get('applications');
  const existing = applications.find(a => a.url === appUrl);
  const entry = { url: appUrl, company: company || existing?.company || '', role: role || existing?.role || page.title, date: new Date().toISOString() };
  const updated = existing
    ? applications.map(a => (a === existing ? { ...a, ...entry } : a))
    : [{ ...entry, status: 'Filled' }, ...applications];
  await chrome.storage.local.set({ applications: updated });
}

// Drops questions whose field belongs to a page that's gone (navigated away or reloaded).
async function liveAsks(tabId) {
  const asks = (await getTab('asks', tabId)) || [];
  if (!asks.length) return asks;
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window.__cf?.docId })
    .catch(() => []);
  const live = new Set(frames.filter(f => f.result).map(f => `${f.frameId}:${f.result}`));
  const kept = asks.filter(a => live.has(a.id.slice(0, a.id.lastIndexOf('-'))));
  if (kept.length !== asks.length) { await setTab('asks', tabId, kept); await showAsks(tabId, kept); }
  return kept;
}

// onlyNew: automatic runs on later steps fill just the fields that weren't there before.
async function fillTab(tabId, { onlyNew = false } = {}) {
  if (running.has(tabId)) return { busy: true };
  running.add(tabId);
  let asks = [];
  try {
    await badge(tabId, '…', '#2563eb');
    const settings = await chrome.storage.local.get(null);
    const { profile, answers = {}, resume } = settings;
    const cfg = llmConfig(settings);
    if (!llmReady(cfg) || !profile) throw new Error('Set up your AI provider and profile first.');

    const target = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['content.js'] });
    const frames = await chrome.scripting.executeScript({ target, func: onlyNew => window.__cf.scan({ onlyNew, mark: true }), args: [onlyNew] });
    const fields = frames.flatMap(f => (f.result?.fields || []).map(x => ({ ...x, id: `${f.frameId}:${x.id}` })));
    const page = frames.find(f => f.frameId === 0)?.result?.page;
    const earlier = onlyNew ? await liveAsks(tabId) : [];
    if (!fields.length) {
      if (!onlyNew) throw new Error('No form fields found on this page.');
      asks = earlier;
      return { filled: 0, asks };
    }

    const { items, company, role } = await mapFields({ profile, answers, page, fields, resume }, cfg);
    const { filled, failed } = await applyItems(tabId, items);

    // Dropdown picks that found no matching option become questions too, instead of a wrong choice.
    const newAsks = items
      .filter(i => i.action === 'ask' || failed.includes(i.id))
      .map(i => ({
        ...i,
        field: fields.find(f => f.id === i.id),
        question: failed.includes(i.id) ? `Couldn't find "${i.value}" in the list. What should it be?` : i.question,
      }));
    asks = [...earlier, ...newAsks];

    const session = (await getTab('session', tabId)) || { origin: new URL(page.url).origin, appUrl: page.url.split('#')[0] };
    session.lastActive = Date.now();
    await setTab('session', tabId, session);
    await setTab('asks', tabId, asks);
    await setTab('error', tabId, '');
    await logApplication(session.appUrl, page, company, role);
    await chrome.scripting.executeScript({ target, func: () => window.__cf.watch() });
    return { filled, asks };
  } catch (e) {
    await setTab('error', tabId, e.message);
    await badge(tabId, '!', '#dc2626');
    return { error: e.message };
  } finally {
    running.delete(tabId);
    if (!(await getTab('error', tabId))) await showAsks(tabId, asks);
  }
}

async function applyAnswers(tabId, answered) {
  const asks = await liveAsks(tabId);
  const items = answered.filter(a => a.value !== '').map(a => ({ ...asks.find(x => x.id === a.id), action: 'fill', value: a.value }));
  const { filled, failed } = await applyItems(tabId, items);
  const { answers = {} } = await chrome.storage.local.get('answers');
  for (const i of items) if (!failed.includes(i.id)) answers[i.field?.label || i.question] = i.value; // remembered for next time
  await chrome.storage.local.set({ answers });
  const answeredIds = new Set(items.map(i => i.id));
  const remaining = asks.filter(a => failed.includes(a.id) || !answeredIds.has(a.id));
  await setTab('asks', tabId, remaining);
  await showAsks(tabId, remaining);
  return { filled, asks: remaining, failed: failed.length };
}

async function stopSession(tabId) {
  await store.remove([k('session', tabId), k('asks', tabId), k('error', tabId)]);
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window.__cf?.unwatch() }).catch(() => {});
  await badge(tabId, '');
}

async function activeSession(tabId) {
  const session = await getTab('session', tabId);
  if (session && Date.now() - session.lastActive > IDLE_MS) { await stopSession(tabId); return null; }
  return session;
}

const handlers = {
  fill: ({ tabId }) => fillTab(tabId),
  apply: ({ tabId, answered }) => applyAnswers(tabId, answered),
  stop: ({ tabId }) => stopSession(tabId).then(() => ({})),
  state: async ({ tabId }) => ({
    session: await activeSession(tabId), asks: await liveAsks(tabId), error: (await getTab('error', tabId)) || '',
  }),
  newFields: async (_, sender) => {
    const tabId = sender.tab?.id;
    if (tabId && await activeSession(tabId)) await fillTab(tabId, { onlyNew: true });
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(respond, e => respond({ error: e.message }));
  return true;
});

// Keyboard shortcut: fill the current tab without opening the popup. The badge shows the result.
async function handleCommand(command) {
  if (command !== 'fill-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await fillTab(tab.id);
}
chrome.commands.onCommand.addListener(handleCommand);

// Next page of a multi-page application: same site → fill it; different site → the application is over.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  const session = await activeSession(tabId);
  if (!session) return;
  if (new URL(tab.url).origin !== session.origin) return stopSession(tabId);
  fillTab(tabId, { onlyNew: true });
});
chrome.tabs.onRemoved.addListener(tabId => store.remove([k('session', tabId), k('asks', tabId), k('error', tabId)]));
