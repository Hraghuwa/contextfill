"""End-to-end check: loads the extension in Chromium, runs resume upload -> confirm -> fill -> ask -> apply.
Groq API calls are stubbed, so no key is needed and no data leaves the machine.
Run: python3 e2e_test.py [path/to/resume.pdf]
"""
import hashlib, http.server, json, os, re, sys, tempfile, threading, urllib.request
from functools import partial
from playwright.sync_api import expect, sync_playwright

EXT = os.path.dirname(os.path.realpath(__file__))
RESUME = sys.argv[1] if len(sys.argv) > 1 else None
# Unpacked extension id = sha256(path), first 32 hex chars mapped 0-f -> a-p.
EXT_ID = ''.join(chr(97 + int(c, 16)) for c in hashlib.sha256(EXT.encode()).hexdigest()[:32])

STUB_PROFILE = {k: '' for k in [
    'firstName', 'lastName', 'email', 'altEmail', 'phone', 'city', 'country', 'linkedin', 'github', 'website',
    'currentTitle', 'currentCompany', 'yearsExperience', 'workAuthorization',
    'needsSponsorship', 'salaryExpectation', 'noticePeriod', 'summary', 'resumeText']}
STUB_PROFILE.update(firstName='ASHA', lastName='Verma', github='N/A', email='asha.verma@students.example.edu',
                    linkedin='linkedin.com/in/asha-verma', summary='Product and GTM professional.',
                    yearsExperience='4',
                    education=[
                        {'level': 'PG', 'degree': 'MBA, Technology Management', 'institution': 'EIM', 'board': '',
                         'startYear': '2025', 'endYear': '2027', 'score': '', 'status': 'Pursuing'},
                        {'level': 'UG', 'degree': 'BA Programme', 'institution': 'Example University', 'board': 'Example University',
                         'startYear': '2020', 'endYear': '2023', 'score': '78.0%', 'status': 'Completed'},
                        {'level': '12th', 'degree': '', 'institution': 'Example Public School', 'board': 'N/A',
                         'startYear': '', 'endYear': '2020', 'score': '83.8%', 'status': 'Completed'},
                        {'level': '10th', 'degree': '', 'institution': 'Example Public School', 'board': '',
                         'startYear': '', 'endYear': '2018', 'score': '73.0%', 'status': 'Completed'}],
                    experience=[
                        {'company': 'Example Sports Pvt. Ltd.', 'title': 'GTM Intern', 'type': 'Internship',
                         'location': '', 'start': 'Mar 2026', 'end': 'Jun 2026', 'description': 'GTM for a running league.'},
                        {'company': 'Example Mart', 'title': 'Co-Founder & Product Lead', 'type': 'Full-time',
                         'location': 'Indore', 'start': 'Jul 2021', 'end': 'Jun 2025', 'description': 'Digital transformation.'}],
                    resumeText='MBA, EIM. Co-founder, Example Mart.')
requests = []


def fake_llm(route):
    try:
        _fake_llm(route)
    except Exception as err:  # surface stub errors instead of hanging the request
        print('stub error:', repr(err))
        route.abort()


def _fake_llm(route):
    body = json.loads(route.request.post_data)
    requests.append((route.request.headers, body))
    content = body['messages'][1]['content']
    props = body['response_format']['json_schema']['schema']['properties']
    if 'education' in props:  # resume parse, history half
        out = {k: STUB_PROFILE[k] for k in props}
    elif 'items' not in props:  # resume parse, basics half
        assert 'resumeText' not in props, 'model should not copy the resume back'
        out = {k: STUB_PROFILE[k] for k in props}
    else:  # field mapping
        fields = json.loads(content)['fields']
        # Name, emails and LinkedIn are filled by rules and must never reach the model.
        # "How soon" reproduces the reported bug: the model pastes the summary with an empty source.
        answers = {'Country': ('fill', 'country', 'India'),
                   'Will you require visa sponsorship?': ('fill', 'needsSponsorship', 'No'),
                   'Why Acme?': ('fill', 'resume', 'I built payments flows at Example Mart.'),
                   'Willing to relocate': ('ask', 'none', 'true'),
                   'How soon can you join?': ('fill', 'noticePeriod', 'Product and GTM professional.'),
                   'Name of your college': ('fill', 'education', 'EIM'),
                   '10th percentage': ('fill', 'education', '73.0%'),
                   'Previous company': ('fill', 'experience', 'Example Sports Pvt. Ltd.'),
                   'Graduation college': ('fill', 'education', 'Example University'),
                   'Current location': ('fill', 'city', 'Bengaluru'),
                   'Highest degree': ('fill', 'education', 'MBA'),
                   'Preferred shift': ('fill', 'savedAnswer', 'Evening'),  # not in the site's list
                   # step 2 (appears without a page load) and step 3 (a new page)
                   'Years of experience': ('fill', 'yearsExperience', '4'),
                   'Expected salary': ('fill', 'salaryExpectation', '10 LPA'),  # profile has none -> guard asks
                   'Current city': ('fill', 'city', 'Bengaluru')}
        assert not any(f['type'] == 'file' for f in fields), 'file inputs never go to the model'
        out = {'company': 'Acme', 'role': 'Software Engineer', 'items': [{'id': f['id'], 'action': answers[f['label']][0], 'source': answers[f['label']][1],
                          'value': answers[f['label']][2],
                          'question': 'Are you willing to relocate?' if f['label'] == 'Willing to relocate' else ''}
                         for f in fields]}
    route.fulfill(json={'choices': [{'message': {'content': json.dumps(out)}, 'finish_reason': 'stop'}]})


claude_requests = []


def fake_claude(route):
    claude_requests.append((route.request.headers, json.loads(route.request.post_data)))
    route.fulfill(json={'content': [{'type': 'text', 'text': json.dumps({'answer': 'ok'})}], 'stop_reason': 'end_turn'})


def ollama_up():
    try:
        return json.load(urllib.request.urlopen('http://localhost:11434/api/tags', timeout=2))['models']
    except Exception:
        return None


def mapping_requests():
    return [json.loads(b['messages'][1]['content']) for _, b in requests if 'items' in b['response_format']['json_schema']['schema']['properties']]


def main():
    # Fills now run in the extension's service worker; let Playwright's routing see its requests.
    os.environ['PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS'] = '1'
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), partial(http.server.SimpleHTTPRequestHandler, directory=EXT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    form_url = f'http://127.0.0.1:{server.server_port}/test-form.html'

    with sync_playwright() as p, tempfile.TemporaryDirectory() as profile_dir:
        ctx = p.chromium.launch_persistent_context(profile_dir, channel='chromium', headless=True, args=[
            f'--disable-extensions-except={EXT}', f'--load-extension={EXT}'])
        ctx.route('https://api.groq.com/**', fake_llm)
        ctx.route('https://api.anthropic.com/**', fake_claude)

        # 1-3. Profile: API key, resume upload, confirm, save.
        opt = ctx.new_page()
        opt.goto(f'chrome-extension://{EXT_ID}/options.html')
        if RESUME:
            # Upload before the key: clear message next to the upload, and the same file can be retried.
            opt.set_input_files('#resume', RESUME)
            expect(opt.locator('#resumeStatus')).to_have_text(re.compile('^Could not read resume: Paste your API key'))
            assert opt.input_value('#resume') == '', 'file input reset for retry'
        opt.fill('#groqKey', 'sk-test-not-real')
        if RESUME:
            opt.set_input_files('#resume', RESUME)
            expect(opt.locator('#resumeStatus')).to_have_text(re.compile('^Done'))
            assert opt.input_value('#firstName') == 'Asha', 'resume parse fills the form, ALL-CAPS name tidied'
            assert opt.input_value('#github') == '', '"N/A" becomes empty'
            assert opt.locator('#education fieldset').nth(2).locator('[data-key="board"]').input_value() == '', 'N/A in lists too'
            _, body = requests[-1]
            text = body['messages'][1]['content']
            assert len(requests) == 2, 'basics + history requests'
            assert opt.input_value('#resumeText') == text.strip(), 'resumeText is the locally extracted text'
            expect(opt.locator('#resumeStatus')).to_have_text(re.compile('Found 4 education and 2 job entries'))
            assert len(text) > 200, 'PDF text extracted locally'
            print('extracted', len(text), 'chars:', text[:80].replace(chr(10), ' | '))
            # Education and jobs land in editable lists; blank added rows are dropped on save.
            assert opt.locator('#education fieldset').count() == 4 and opt.locator('#experience fieldset').count() == 2
            assert opt.locator('#education fieldset').nth(3).locator('[data-key="score"]').input_value() == '73.0%'
            opt.click('#education >> text=Add education')
            opt.locator('#experience fieldset').nth(1).locator('[data-key="location"]').fill('Indore, MP')
        opt.fill('#email', 'asha.verma@example.com')
        opt.fill('#altEmail', 'asha.verma@students.example.edu')
        opt.fill('#firstName', 'Asha')
        opt.fill('#linkedin', 'linkedin.com/in/asha-verma')
        opt.fill('#city', 'Bengaluru')
        opt.fill('#needsSponsorship', 'No')
        opt.fill('#country', 'India')
        opt.locator('#lists').screenshot(path=os.path.join(tempfile.gettempdir(), 'contextfill-lists.png'))
        opt.click('#save')
        expect(opt.locator('#status')).to_have_text('Saved.')
        stored = opt.evaluate('chrome.storage.local.get(null)')
        assert stored['profile']['city'] == 'Bengaluru' and stored['llm']['keys']['groq'] == 'sk-test-not-real' \
            and stored['llm']['provider'] == 'groq', 'profile saved'
        if RESUME:
            assert len(stored['profile']['education']) == 4, stored['profile']['education']
            assert stored['resume']['name'] == os.path.basename(RESUME) and len(stored['resume']['data']) > 1000, 'resume file stored'
            expect(opt.locator('#resumeFile')).to_have_text(f'On file for upload fields: {os.path.basename(RESUME)}')
            assert stored['profile']['experience'][1]['location'] == 'Indore, MP'

        # Providers. Claude: request shape (stubbed). Ollama: real local server, if running.
        schema = {'type': 'object', 'additionalProperties': False, 'required': ['answer'], 'properties': {'answer': {'type': 'string'}}}
        out = opt.evaluate("s => callLLM({ provider: 'claude', key: 'sk-ant-test', model: 'claude-opus-5' }, 'sys', 'hi', s)", schema)
        headers, body = claude_requests[-1]
        assert out == {'answer': 'ok'} and headers['x-api-key'] == 'sk-ant-test' and headers['anthropic-version'] == '2023-06-01'
        assert headers['anthropic-beta'] == 'server-side-fallback-2026-07-01' and body['fallbacks'] == 'default'
        assert body['output_config']['format'] == {'type': 'json_schema', 'schema': schema} and body['system'] == 'sys'
        opt.evaluate("s => callLLM({ provider: 'claude', key: 'k', model: 'claude-sonnet-5' }, 'sys', 'hi', s)", schema)
        assert 'fallbacks' not in claude_requests[-1][1] and 'anthropic-beta' not in claude_requests[-1][0], 'no fallback for non-Opus models'
        assert opt.evaluate("""() => normalizeOllamaUrl('http://localhost:11434')""") == 'http://localhost:11434'
        assert not opt.evaluate("""() => normalizeOllamaUrl('https://example.test')"""), 'Ollama rejects non-loopback endpoints'
        sensitive = opt.evaluate("""() => ruleFill([{
            id: 'sensitive', type: 'text', label: 'National ID', hint: '', context: '', current: ''
          }], {}, null)[0]""")
        assert sensitive == [{'id': 'sensitive', 'action': 'ask', 'source': 'none', 'value': '',
                              'question': 'For your security, enter this value yourself on the website.'}], sensitive
        normalized = opt.evaluate("""async () => {
          const original = callLLM;
          callLLM = async () => ({ company: '', role: '', items: [
            { id: 'field', action: 'fill', source: 'savedAnswer', value: 'first', question: '' },
            { id: 'field', action: 'fill', source: 'savedAnswer', value: 'second', question: '' },
            { id: 'unknown', action: 'fill', source: 'savedAnswer', value: 'third', question: '' },
          ] });
          try {
            return await mapFields({ profile: {}, answers: {}, page: {}, fields: [
              { id: 'field', type: 'text', label: 'Custom question', hint: '', context: '', current: '' }
            ] }, { provider: 'groq', key: 'test' });
          } finally { callLLM = original; }
        }""")
        assert normalized['items'] == [{'id': 'field', 'action': 'fill', 'source': 'savedAnswer', 'value': 'first', 'question': ''}], normalized
        models = ollama_up()
        if models:
            opt.select_option('#provider', 'ollama')
            expect(opt.locator('#ollamaStatus')).to_have_text(re.compile(r'^\d+ installed'), timeout=10000)  # header rule works
            small = min(models, key=lambda m: m['size'])['name']
            got = opt.evaluate("""([m, s]) => callLLM({ provider: 'ollama', url: 'http://localhost:11434', model: m },
                'Reply with JSON.', 'Say ok in the answer field.', s)""", [small, schema])
            assert isinstance(got.get('answer'), str), got
            print('ollama', small, '->', got)
            opt.select_option('#provider', 'groq')
        else:
            print('ollama not running; skipped live Ollama check')

        # 4-9. Visit a form, fill from the popup.
        form = ctx.new_page()
        form.goto(form_url)
        form.evaluate("window.submitted = false; document.forms[0].addEventListener('submit', e => { e.preventDefault(); window.submitted = (e.submitter && e.submitter.outerHTML) || 'no submitter'; console.log('SUBMIT', window.submitted, new Error().stack); })")
        popup = ctx.new_page()
        popup.goto(f'chrome-extension://{EXT_ID}/popup.html')
        # The toolbar button can't be clicked headlessly; point the popup at the form tab instead.
        popup.evaluate("""async url => {
            const [t] = await chrome.tabs.query({ url: url + '*' });
            chrome.tabs.query = async () => [t];
        }""", form_url)
        popup.click('#fill')
        expect(popup.locator('#status')).to_have_text(re.compile('^Filled'), timeout=15000)
        print('popup:', popup.text_content('#status'))

        headers, body = requests[-1]
        assert headers['authorization'] == 'Bearer sk-test-not-real'
        assert body['response_format']['json_schema']['strict'] and body['model'] == 'openai/gpt-oss-120b'
        sent = json.loads(body['messages'][1]['content'])
        assert sent['page']['title'] == 'ContextFill test form' and sent['profile']['city'] == 'Bengaluru', 'page + profile sent'
        assert sorted(x['label'] for x in sent['fields']) == sorted(answers_labels := [
            'Country', 'Will you require visa sponsorship?', 'Willing to relocate', 'Why Acme?',
            'How soon can you join?', 'Name of your college', '10th percentage', 'Previous company',
            'Graduation college', 'Current location', 'Highest degree', 'Preferred shift']), [x['label'] for x in sent['fields']]
        assert 'resume' not in sent and 'JVBERi' not in body['messages'][1]['content'], 'resume file never sent to the model'

        f = form.evaluate("""() => { const f = document.forms[0]; return {
            first: f.first_name.value, email: f.email.value, country: f.country.value, visa: f.visa.value,
            relocate: f.relocate.checked, why: document.querySelector('#why').value,
            li: f.linkedin.value, cem: document.querySelector('#cem').value,
            join: document.querySelector('#join').value, col: document.querySelector('#col').value,
            x10: document.querySelector('#x10').value, prev: document.querySelector('#prev').value,
            ug: document.querySelector('#ug').value, loc: loc.dataset.value, deg: deg.dataset.value,
            shift: shift.dataset.value || '', cv: f.cv.files[0] ? [f.cv.files[0].name, f.cv.files[0].size] : null,
            cover: f.cover.files.length }; }""")
        assert f == {'first': 'Asha', 'email': 'asha.verma@example.com', 'country': 'in', 'visa': 'n',
                     'relocate': False, 'why': 'I built payments flows at Example Mart.',
                     'li': 'https://linkedin.com/in/asha-verma',
                     'cem': 'asha.verma@students.example.edu', 'join': '', 'col': 'EIM',
                     'x10': '73.0%', 'prev': 'Example Sports Pvt. Ltd.', 'ug': 'Example University',
                     'loc': 'Bengaluru', 'deg': 'MBA', 'shift': '',
                     'cv': [os.path.basename(RESUME), os.path.getsize(RESUME)] if RESUME else None, 'cover': 0}, f

        # 10. It asks when uncertain; the answer is applied and remembered.
        labels = popup.locator('#asks label').all_text_contents()
        assert labels == ['Are you willing to relocate?', 'How soon can you join?',
                          'Couldn\'t find "Evening" in the list. What should it be?'], labels
        assert popup.input_value('#ask1') == 'Product and GTM professional.'  # suggestion shown, not filled
        popup.select_option('#ask0', 'true')
        popup.fill('#ask1', '')  # user leaves it blank
        popup.fill('#ask2', 'Day')
        popup.click('#apply')
        expect(popup.locator('#status')).to_have_text(re.compile('^Filled 2 more'))
        assert form.evaluate('shift.dataset.value') == 'Day', 'retry with user answer picks the option'
        assert form.evaluate('document.forms[0].relocate.checked'), 'ask answer applied'
        answers = popup.evaluate('chrome.storage.local.get("answers")')['answers']
        assert answers == {'Willing to relocate': 'true', 'Preferred shift': 'Day'}, answers

        # Tracker: the fill was logged; status is editable; CSV export works.
        apps = popup.evaluate('chrome.storage.local.get("applications")')['applications']
        assert len(apps) == 1 and apps[0]['company'] == 'Acme' and apps[0]['role'] == 'Software Engineer' \
            and apps[0]['status'] == 'Filled' and apps[0]['url'] == form_url, apps
        expect(popup.locator('#tracker')).to_have_text('Applications (1)')
        tracker = ctx.new_page()
        tracker.goto(f'chrome-extension://{EXT_ID}/tracker.html')
        expect(tracker.locator('#rows tr')).to_have_count(1)
        tracker.select_option('#rows select', 'Applied')
        tracker.wait_for_timeout(200)
        assert tracker.evaluate('chrome.storage.local.get("applications")')['applications'][0]['status'] == 'Applied'
        with tracker.expect_download() as dl:
            tracker.click('#export')
        tracker.screenshot(path=os.path.join(tempfile.gettempdir(), 'contextfill-tracker.png'))
        csv = open(dl.value.path()).read()
        assert csv.splitlines()[0] == '"Date","Company","Role","Status","URL"' and '"Acme","Software Engineer","Applied"' in csv, csv

        # 11-12. User reviews and submits; the extension never does.
        assert not form.evaluate('window.submitted'), form.evaluate('window.submitted')
        form.screenshot(path=os.path.join(tempfile.gettempdir(), 'contextfill-e2e.png'), full_page=True)

        badge = lambda: popup.evaluate('async () => chrome.action.getBadgeText({ tabId: (await chrome.tabs.query({}))[0].id })')
        assert badge() == '1', f'badge counts the open question, got {badge()!r}'  # "How soon" left blank
        popup.reload()
        popup.evaluate("""async url => {
            const [t] = await chrome.tabs.query({ url: url + '*' });
            chrome.tabs.query = async () => [t];
            showState(await send('state'));
        }""", form_url)
        # popup state comes from the background: session banner + the still-open question survive reopening
        expect(popup.locator('#session')).to_be_visible()
        expect(popup.locator('#asks label')).to_have_text(['How soon can you join?'])

        # Multi-page, step 2: fields appear without a page load; only they are sent and filled.
        before = len(mapping_requests())
        form.click('#nextstep')
        expect(form.locator('#yoe')).to_have_value('4', timeout=15000)
        step2 = mapping_requests()[before:]
        assert len(step2) == 1 and sorted(f['label'] for f in step2[0]['fields']) == ['Expected salary', 'Years of experience'], step2
        form.wait_for_timeout(300)
        assert badge() == '2', f'earlier question + salary, got {badge()!r}'

        # Multi-page, step 3: a real page load on the same site is filled automatically.
        form.click('#next3')
        expect(form.locator('#city')).to_have_value('Bengaluru', timeout=15000)
        form.wait_for_timeout(300)
        assert badge() == '', f'questions from the previous page are dropped, got {badge()!r}'
        apps = popup.evaluate('chrome.storage.local.get("applications")')['applications']
        assert len(apps) == 1 and apps[0]['url'] == form_url and apps[0]['status'] == 'Applied', apps

        # Keyboard shortcut: the command handler fills the active tab without the popup.
        form.fill('#city', '')
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        sw.evaluate("""async url => {
            const [t] = await chrome.tabs.query({ url });
            chrome.tabs.query = async () => [t];
            await handleCommand('fill-page');
        }""", form.url)
        expect(form.locator('#city')).to_have_value('Bengaluru')

        # Stop: later pages are left alone.
        popup.reload()
        popup.evaluate("""async url => {
            const [t] = await chrome.tabs.query({ url });
            chrome.tabs.query = async () => [t];
            showState(await send('state'));
        }""", form.url)
        expect(popup.locator('#session')).to_be_visible()
        popup.click('#stop')
        expect(popup.locator('#session')).to_be_hidden()
        before = len(mapping_requests())
        form.reload()
        form.wait_for_timeout(2500)
        assert form.input_value('#city') == '' and len(mapping_requests()) == before, 'no auto-fill after Stop'
        ctx.close()
    print('PASS')


if __name__ == '__main__':
    main()
