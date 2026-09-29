// Injected into every frame of the active tab. Reads fields, fills them. Never submits.
window.__cf ??= (() => {
  const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password']);
  const clean = (s, n = 300) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const norm = s => clean(s).toLowerCase();
  const visible = el => el.getClientRects().length > 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Custom dropdowns: typeahead inputs (React-Select, MUI) and button-opened lists (Workday "Select One").
  const isCombo = el => el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') ||
    el.getAttribute('aria-haspopup') === 'listbox';
  // Field ids stay stable for the life of the page, so questions asked on step 1 still point at the
  // right field after step 2 is scanned. docId changes on every page load, which makes old ids stale.
  const docId = Math.random().toString(36).slice(2, 8);
  const ids = new WeakMap();
  const targets = new Map(); // id -> element, or array of radios
  const handled = new WeakSet(); // fields already seen in this application, so later steps only get new ones
  let nextId = 0;
  const idOf = el => ids.get(el) || (ids.set(el, `${docId}-${nextId++}`), ids.get(el));
  let busy = false;

  function label(el) {
    // Clone and drop controls, so a <select> wrapped in its label doesn't leak its options into the text.
    if (el.labels?.length) return clean([...el.labels].map(l => {
      const c = l.cloneNode(true);
      c.querySelectorAll('input, select, textarea').forEach(x => x.remove());
      return c.textContent;
    }).join(' '));
    const by = el.getAttribute('aria-labelledby');
    if (by) return clean(by.split(/\s+/).map(id => document.getElementById(id)?.innerText).join(' '));
    return clean(el.getAttribute('aria-label') || el.placeholder || el.title || el.name || el.id);
  }

  // Surrounding text, for forms that don't label their fields properly.
  const context = el => clean(el.closest('fieldset, [role=group], li, div')?.innerText);

  // onlyNew: skip fields handled on an earlier step. mark: remember the returned fields as handled.
  function scan({ onlyNew = false, mark = false } = {}) {
    const fields = [];
    const radios = new Map();
    const add = (target, field) => {
      const el = Array.isArray(target) ? target[0] : target;
      if (onlyNew && handled.has(el)) return;
      if (mark) handled.add(el);
      field.id = idOf(el);
      targets.set(field.id, target);
      fields.push(field);
    };
    const selector = 'input, textarea, select, button[aria-haspopup="listbox"], [role="combobox"]:not(input):not(select)';

    for (const el of document.querySelectorAll(selector)) {
      if (SKIP.has(el.type) && el.tagName !== 'BUTTON' || el.disabled || el.readOnly) continue;
      // File inputs are often hidden behind a styled "Upload" button, so don't require them to be visible.
      if (el.type !== 'file' && !visible(el)) continue;
      // ARIA 1.1 wrapper pattern: the div is the combobox but the input inside is what we drive.
      if (el.tagName !== 'INPUT' && el.getAttribute('role') === 'combobox' && el.querySelector('input')) continue;
      if (el.closest('[role="listbox"]')) continue; // search boxes inside an open dropdown aren't form fields
      if (el.type === 'radio') {
        const key = el.name || label(el);
        let g = radios.get(key);
        if (!g) {
          g = { els: [el], field: { type: 'radio', label: clean(el.closest('fieldset')?.querySelector('legend')?.innerText) || context(el), options: [] } };
          radios.set(key, g);
          add(g.els, g.field);
        } else g.els.push(el);
        g.field.options.push(label(el) || el.value);
        if (el.checked) g.field.current = label(el) || el.value;
        continue;
      }
      const isSelect = el.tagName === 'SELECT';
      const combo = !isSelect && isCombo(el);
      add(el, {
        type: isSelect ? 'select' : combo ? 'combobox' : el.type || 'text',
        label: label(el),
        hint: clean(`${el.name || ''} ${el.id} ${el.getAttribute('autocomplete') || ''} ${el.accept || ''}`),
        context: context(el),
        current: el.type === 'checkbox' ? String(el.checked)
          : isSelect ? clean(el.selectedOptions[0]?.text)
          : el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? (el.type === 'file' ? el.files[0]?.name || '' : el.value)
          : clean(el.innerText, 80),
        ...(isSelect && { options: [...el.options].map(o => clean(o.text)).filter(Boolean) }),
        ...(el.required && { required: true }),
      });
    }
    return { docId, fields, page: { url: location.href, title: document.title, text: clean(document.body?.innerText, 4000) } };
  }

  function setValue(t, v, blur = true) {
    // Native setter + events so React/Vue-controlled inputs notice the change.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'value').set.call(t, v);
    for (const type of ['input', 'change', ...(blur ? ['blur'] : [])]) t.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function attachFile(t, { name, type, data }) {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    t.files = dt.files;
    for (const e of ['input', 'change']) t.dispatchEvent(new Event(e, { bubbles: true }));
  }

  function listOptions(t) {
    const id = t.getAttribute('aria-controls') || t.getAttribute('aria-owns');
    const root = (id && document.getElementById(id)) || document;
    return [...root.querySelectorAll('[role="option"]')].filter(visible);
  }

  // Exact match beats prefix beats substring; nothing matching means don't guess.
  function bestOption(opts, v) {
    const want = norm(v);
    let top = null, topScore = 0;
    for (const o of opts) {
      const text = norm(o.innerText || o.textContent);
      const score = !text ? 0 : text === want ? 3 : text.startsWith(want) ? 2 : text.includes(want) || want.includes(text) ? 1 : 0;
      if (score > topScore) { top = o; topScore = score; }
    }
    return top;
  }

  async function pickOption(t, v) {
    t.scrollIntoView({ block: 'center' });
    t.focus();
    if (t.tagName === 'INPUT') setValue(t, v, false); // typing opens and filters typeahead lists
    else t.click(); // button-style dropdowns open on click
    // ponytail: polls up to 2s for the list; slow remote searches can miss and fall back to asking.
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const o = bestOption(listOptions(t), v);
      if (o) { o.scrollIntoView({ block: 'nearest' }); o.click(); return true; }
    }
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  // Returns true when the value landed.
  async function set(t, v) {
    if (Array.isArray(t)) {
      const r = t.find(el => norm(label(el) || el.value) === norm(v));
      if (r && !r.checked) r.click();
      return !!r;
    }
    if (t.type === 'file') return v?.data ? (attachFile(t, v), true) : false;
    if (t.type === 'checkbox') {
      if (t.checked !== (v === 'true')) t.click();
      return true;
    }
    if (t.tagName === 'SELECT') {
      const o = [...t.options].find(o => norm(o.text) === norm(v));
      if (!o) return false;
      v = o.value;
    }
    if (isCombo(t)) return pickOption(t, v);
    setValue(t, v);
    return true;
  }

  function mark(t, color) {
    // Hidden file inputs: outline their label if they have one; never a big parent like the whole form.
    const el = Array.isArray(t) ? t[0].closest('fieldset') || t[0] : visible(t) ? t : t.labels?.[0];
    if (!el) return;
    el.style.outline = `2px solid ${color}`;
    el.style.outlineOffset = '2px';
  }

  async function fill(items) {
    const failed = [];
    let filled = 0;
    busy = true; // our own DOM changes (dropdowns opening) must not look like a new form step
    try {
      for (const { id, action, value } of items) {
        const t = targets.get(id);
        if (!t || action === 'skip') continue;
        const ok = action === 'fill' && await set(t, value);
        if (ok) filled++;
        else if (action === 'fill') failed.push(id);
        mark(t, ok ? '#16a34a' : '#f59e0b');
      }
    } finally {
      setTimeout(() => { busy = false; }, 500);
    }
    return { filled, failed };
  }

  // Multi-step forms (Workday-style "Next" without a page load): tell the extension when new fields appear.
  let observer, timer;
  function watch() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (busy) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!busy && scan({ onlyNew: true }).fields.length) chrome.runtime.sendMessage({ type: 'newFields' }).catch(() => {});
      }, 1200);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
  }
  function unwatch() { observer?.disconnect(); observer = null; clearTimeout(timer); }

  return { docId, scan, fill, watch, unwatch };
})();
