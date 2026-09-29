// Thin UI: the background worker does the filling, so closing this popup never loses work.
const $ = s => document.querySelector(s);
let asks = [];

function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').className = error ? 'error' : '';
}

async function send(type, extra = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return chrome.runtime.sendMessage({ type, tabId: tab.id, ...extra });
}

const showTrackerCount = apps => { $('#tracker').textContent = `Applications (${apps.length})`; };
const refreshTracker = () => chrome.storage.local.get('applications').then(({ applications = [] }) => showTrackerCount(applications));

function showState({ session, asks: pending = [], error = '' }) {
  asks = pending;
  $('#session').hidden = !session;
  renderAsks();
  if (error) status(error, true);
  else if (asks.length) status(`${asks.length} need your input (orange on the page).`);
}

$('#fill').onclick = async () => {
  $('#fill').disabled = true;
  status('Working… you can close this; the badge shows when it is done.');
  try {
    const r = await send('fill');
    if (r.error) {
      status(r.error, true);
      if (r.error.startsWith('Set up')) chrome.runtime.openOptionsPage();
      return;
    }
    if (r.busy) return status('Already filling this page…');
    showState({ session: true, asks: r.asks });
    status(`Filled ${r.filled} field${r.filled === 1 ? '' : 's'}. ` +
      (asks.length ? `${asks.length} need your input (orange on the page).` : 'Review the page, then submit it yourself.'));
    refreshTracker();
  } finally {
    $('#fill').disabled = false;
  }
};

function renderAsks() {
  $('#asks').replaceChildren(...asks.map((a, n) => {
    const wrap = document.createElement('div');
    wrap.className = 'ask';
    const label = document.createElement('label');
    label.htmlFor = `ask${n}`;
    label.textContent = a.question || a.field?.label || 'Answer';
    let input;
    if (a.field?.options) {
      input = document.createElement('select');
      input.append(new Option('— leave blank —', ''), ...a.field.options.map(o => new Option(o, o, false, o === a.value)));
    } else if (a.field?.type === 'checkbox') {
      input = document.createElement('select');
      input.append(new Option('Unchecked', 'false'), new Option('Checked', 'true', false, a.value === 'true'));
    } else {
      input = document.createElement('textarea');
      input.rows = 2;
      input.value = a.value;
    }
    input.id = `ask${n}`;
    wrap.append(label, input);
    return wrap;
  }));
  $('#apply').hidden = !asks.length;
}

$('#apply').onclick = async () => {
  const answered = asks.map((a, n) => ({ id: a.id, value: $(`#ask${n}`).value }));
  const r = await send('apply', { answered });
  if (r.error) return status(r.error, true);
  asks = r.asks;
  renderAsks();
  status(`Filled ${r.filled} more. ` +
    (r.failed ? `${r.failed} still didn't match the site's list; pick it on the page.` : 'Review the page, then submit it yourself.'));
};

$('#stop').onclick = async e => {
  e.preventDefault();
  await send('stop');
  showState({ session: null, asks: [] });
  status('Stopped. Later pages won\'t be filled automatically.');
};

// Show the shortcut the user actually has (Chrome leaves it unset if another extension took it).
chrome.commands.getAll().then(cmds => {
  const key = cmds.find(c => c.name === 'fill-page')?.shortcut;
  $('#keys').textContent = key || 'not set (chrome://extensions/shortcuts)';
}).catch(() => {});

refreshTracker();
send('state').then(showState).catch(() => {});
