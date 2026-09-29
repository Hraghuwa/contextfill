"""Live check of resume extraction against a real provider (no stubs).
Groq:   python3 check_resume.py path/to/resume.pdf            (asks for your key, hidden; never printed)
Ollama: python3 check_resume.py path/to/resume.pdf --ollama gemma4:latest   (local, nothing leaves this computer)
"""
import getpass, json, os, re, sys, tempfile, time
from playwright.sync_api import expect, sync_playwright
from e2e_test import EXT, EXT_ID

if len(sys.argv) < 2:
    sys.exit(__doc__)
ollama = sys.argv[sys.argv.index('--ollama') + 1] if '--ollama' in sys.argv else None
if not ollama:
    key = os.environ.get('GROQ_API_KEY') or getpass.getpass('Paste your Groq API key (starts with gsk_, hidden): ').strip()
    if not key.startswith('gsk_') or 'yourRealKey' in key or 'paste' in key:
        sys.exit('That is not a Groq key. Copy yours from https://console.groq.com/keys (starts with gsk_).')

with sync_playwright() as p, tempfile.TemporaryDirectory() as profile_dir:
    ctx = p.chromium.launch_persistent_context(profile_dir, channel='chromium', headless=True, args=[
        f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
    responses = []
    ctx.on('response', lambda r: 'api.groq.com' in r.url and responses.append(r))
    opt = ctx.new_page()
    opt.goto(f'chrome-extension://{EXT_ID}/options.html')
    if ollama:
        opt.select_option('#provider', 'ollama')
        expect(opt.locator('#ollamaStatus')).to_have_text(re.compile('installed'), timeout=10000)
        opt.select_option('#ollamaModel', ollama)
    else:
        opt.fill('#groqKey', key)
    started = time.time()
    opt.set_input_files('#resume', sys.argv[1])
    expect(opt.locator('#resumeStatus')).to_have_text(re.compile('^(Done|Could not)'), timeout=600000)
    print(f'took {time.time() - started:.0f}s')
    print('status:', opt.text_content('#resumeStatus'))
    for r in responses:
        body = r.text()
        print('groq', r.status, body[:600] if r.status != 200 else '(ok)')
    fields = opt.evaluate("""() => Object.fromEntries([...document.querySelectorAll('#profile input, #profile textarea')]
        .map(el => [el.id, el.value.slice(0, 60)]))""")
    print(json.dumps({k: v for k, v in fields.items() if v}, indent=1))
    for name in ('education', 'experience'):
        print(name, 'entries:', opt.locator(f'#{name} fieldset').count())
        for fs in opt.locator(f'#{name} fieldset').all():
            print('  ', {el.get_attribute('data-key'): el.input_value()[:40] for el in fs.locator('[data-key]').all() if el.input_value()})
    ctx.close()
