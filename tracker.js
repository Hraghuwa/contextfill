const $ = s => document.querySelector(s);
const STATUSES = ['Filled', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'];
let apps = [];

const save = () => chrome.storage.local.set({ applications: apps });
const cell = (...children) => { const td = document.createElement('td'); td.append(...children); return td; };

// Company, role and status are editable in place; the model's guess from the page can be wrong.
function editable(app, key) {
  const input = Object.assign(document.createElement('input'), { value: app[key] || '', 'aria-label': key });
  input.onchange = () => { app[key] = input.value.trim(); save(); };
  return input;
}

function render() {
  $('#rows').replaceChildren(...apps.map(app => {
    const tr = document.createElement('tr');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Status');
    select.append(...STATUSES.map(s => new Option(s, s, false, s === app.status)));
    select.onchange = () => { app.status = select.value; save(); };
    const link = Object.assign(document.createElement('a'), { href: app.url, target: '_blank', textContent: new URL(app.url).hostname });
    const remove = Object.assign(document.createElement('button'), { textContent: 'Delete' });
    remove.onclick = () => { apps = apps.filter(a => a !== app); save(); render(); };
    tr.append(cell(new Date(app.date).toLocaleDateString()), cell(editable(app, 'company')), cell(editable(app, 'role')),
      cell(select), cell(link), cell(remove));
    return tr;
  }));
  $('#empty').hidden = apps.length > 0;
  $('#count').textContent = `${apps.length} application${apps.length === 1 ? '' : 's'}`;
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

$('#export').onclick = () => {
  const rows = [['Date', 'Company', 'Role', 'Status', 'URL'],
    ...apps.map(a => [a.date.slice(0, 10), a.company, a.role, a.status, a.url])];
  const blob = new Blob([rows.map(r => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'applications.csv' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

chrome.storage.local.get('applications').then(({ applications = [] }) => { apps = applications; render(); });
