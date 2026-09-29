const $ = s => document.querySelector(s);
const status = t => { $('#status').textContent = t; };
const LONG = new Set(['summary', 'resumeText']);

$('#profile').append(...PROFILE_FIELDS.flatMap(([key, text]) => {
  const label = document.createElement('label');
  label.htmlFor = key;
  label.textContent = text;
  const input = document.createElement(LONG.has(key) ? 'textarea' : 'input');
  input.id = key;
  if (key === 'resumeText') input.rows = 12;
  return [label, input];
}));

// Editable list of entries (education, jobs). Inputs are wrapped in their labels, so no ids needed.
function listEditor(name) {
  const { title, add, keys } = LIST_FIELDS[name];
  const box = document.createElement('div');
  box.id = name;
  const heading = document.createElement('h3');
  heading.textContent = title;
  const rows = document.createElement('div');
  const button = (text, onclick) => Object.assign(document.createElement('button'), { type: 'button', textContent: text, onclick });
  const row = entry => {
    const fs = document.createElement('fieldset');
    fs.className = 'entry';
    for (const [k, text] of keys) {
      const label = document.createElement('label');
      const input = document.createElement(k === 'description' ? 'textarea' : 'input');
      input.dataset.key = k;
      input.value = entry[k] || '';
      label.append(text, input);
      fs.append(label);
    }
    fs.append(button('Remove', () => fs.remove()));
    return fs;
  };
  box.append(heading, rows, button(add, () => rows.append(row({}))));
  box.set = entries => rows.replaceChildren(...(Array.isArray(entries) ? entries : []).map(row));
  box.get = () => [...rows.children]
    .map(fs => Object.fromEntries(keys.map(([k]) => [k, fs.querySelector(`[data-key="${k}"]`).value.trim()])))
    .filter(e => Object.values(e).some(Boolean));
  return box;
}
const lists = Object.fromEntries(Object.keys(LIST_FIELDS).map(n => [n, listEditor(n)]));
$('#lists').append(...Object.values(lists));

function showProfile(p = {}) {
  for (const [key] of PROFILE_FIELDS) $(`#${key}`).value = p[key] || '';
  for (const [name, box] of Object.entries(lists)) box.set(p[name]);
}

// --- AI provider ---
$('#provider').append(...Object.entries(PROVIDERS).map(([id, p]) => new Option(p.label, id)));
const showProvider = () => {
  for (const div of document.querySelectorAll('[data-provider]')) div.hidden = div.dataset.provider !== $('#provider').value;
  if ($('#provider').value === 'ollama' && !$('#ollamaModel').options.length) refreshOllama();
};
$('#provider').onchange = showProvider;

async function refreshOllama(selected = $('#ollamaModel').value) {
  const url = $('#ollamaUrl').value.trim() || PROVIDERS.ollama.url;
  $('#ollamaStatus').textContent = 'Looking for installed models…';
  try {
    const models = await ollamaModels(url);
    $('#ollamaModel').replaceChildren(...models.map(m => new Option(m, m, false, m === selected)));
    $('#ollamaStatus').textContent = models.length ? `${models.length} installed` : 'No models installed. Run: ollama pull gemma3';
  } catch {
    $('#ollamaStatus').textContent = `Can't reach Ollama at ${url}. Is it running?`;
  }
}
$('#ollamaRefresh').onclick = () => refreshOllama();

// Form -> stored shape (see llmConfig in llm.js).
const readLlm = () => ({
  provider: $('#provider').value,
  keys: { groq: $('#groqKey').value.trim(), claude: $('#claudeKey').value.trim() },
  models: { groq: $('#groqModel').value.trim(), claude: $('#claudeModel').value.trim(), ollama: $('#ollamaModel').value },
  ollamaUrl: $('#ollamaUrl').value.trim(),
});

chrome.storage.local.get(null).then(settings => {
  const { profile, answers = {}, resume } = settings;
  const { llm = {} } = settings;
  const cfg = llmConfig(settings);
  $('#provider').value = cfg.provider;
  $('#groqKey').value = llm.keys?.groq || settings.apiKey || '';
  $('#claudeKey').value = llm.keys?.claude || '';
  $('#groqModel').value = llm.models?.groq || '';
  $('#claudeModel').value = llm.models?.claude || '';
  $('#ollamaUrl').value = llm.ollamaUrl || '';
  if (llm.models?.ollama) $('#ollamaModel').append(new Option(llm.models.ollama, llm.models.ollama, true, true));
  showProvider();
  showResumeFile(resume);
  showProfile(profile);
  $('#answers').value = JSON.stringify(answers, null, 2);
});

// Shown right under the upload box, where the user is looking.
const resumeStatus = t => { $('#resumeStatus').textContent = t; };
const showResumeFile = r => { $('#resumeFile').textContent = r ? `On file for upload fields: ${r.name}` : ''; };
let pendingResume = null; // the file itself, kept locally so forms' resume upload fields can be filled

const toBase64 = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result.split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(file);
});

$('#resume').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  const cfg = llmConfig({ llm: readLlm() });
  try {
    if (!llmReady(cfg)) {
      throw new Error(cfg.provider === 'ollama' ? 'Pick an Ollama model above first, then choose the file again.'
        : 'Paste your API key above first, then choose the file again.');
    }
    resumeStatus('Reading resume… (10–30 seconds)');
    const p = await parseResume(file, cfg);
    showProfile(p);
    pendingResume = { name: file.name, type: file.type || 'application/pdf', data: await toBase64(file) };
    resumeStatus(`Done. Found ${p.education.length} education and ${p.experience.length} job entries. ` +
      'Check every field below, then save.');
  } catch (err) {
    resumeStatus(`Could not read resume: ${err.message}`);
    e.target.value = ''; // so picking the same file again fires change
  }
};

$('#save').onclick = async () => {
  let answers;
  try {
    answers = JSON.parse($('#answers').value || '{}');
  } catch {
    return status('Saved answers is not valid JSON.');
  }
  const profile = Object.fromEntries(PROFILE_FIELDS.map(([k]) => [k, $(`#${k}`).value.trim()]));
  for (const [name, box] of Object.entries(lists)) profile[name] = box.get();
  await chrome.storage.local.set({ llm: readLlm(), profile, answers, ...(pendingResume && { resume: pendingResume }) });
  await chrome.storage.local.remove('apiKey'); // replaced by llm.keys.groq
  if (pendingResume) showResumeFile(pendingResume);
  pendingResume = null;
  status('Saved.');
};
