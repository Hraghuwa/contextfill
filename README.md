# ContextFill

A Chrome and Safari extension that fills job applications and other web forms from your profile and resume.
It understands each field, fills what your data clearly answers, asks you when it isn't sure, and never submits.
You review and submit.

## What it does

- **Profile from your resume.** Upload a PDF; the text is extracted locally (pdf.js) and an AI model fills in
  your details, education (10th, 12th, UG, PG with marks) and work history. You check and save.
- **Understands the form.** Reads labels, surrounding text and the job description, then decides per field:
  fill, ask you, or skip.
- **Doesn't make things up.** Every AI answer must name the profile field it came from; answers from an empty
  field become questions for you instead of text in the form.
- **Fixed rules for the obvious fields.** Name, email (primary vs. university/alternate), phone, LinkedIn,
  GitHub and website are filled without the AI.
- **Attaches your resume** to resume/CV upload fields (not cover letter or photo fields).
- **Custom dropdowns.** Types into search-style boxes and opens button-style lists (React-Select, Workday),
  picks the matching option, and asks you if nothing matches.
- **Multi-page applications.** New steps (without a page load) and new pages on the same site are filled as
  they appear. Stop any time from the popup.
- **Keyboard shortcut:** `Alt+Shift+F` (Option+Shift+F on Mac). The toolbar badge shows progress and open questions.
- **Applications tracker** with status (Filled → Applied → Interviewing → Offer/Rejected) and CSV export.

## AI providers

| Provider | Cost | Notes |
|---|---|---|
| Groq | Free tier | Default. Key from [console.groq.com/keys](https://console.groq.com/keys). |
| Claude | Paid | Best written answers. Key from [console.anthropic.com](https://console.anthropic.com/settings/keys). |
| Ollama | Free | Runs on your computer; nothing leaves it. Slower. Install a model, e.g. `ollama pull gemma3`. |

Keys are stored only in your browser. With Groq or Claude, your profile text and the form's contents are sent
to that provider; your resume file itself is never sent.

## Install

**Chrome:** open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, pick this folder.
Open the extension's options page, choose a provider, upload your resume, check the fields, save.

**Safari (macOS, needs Xcode):**

```bash
./build-safari.sh
```

Then open `~/Applications/ContextFill.app` once, enable Safari → Develop → **Allow Unsigned Extensions**
(Safari resets this on quit), and turn on ContextFill in Safari → Settings → Extensions.

## Development

No build step: plain JavaScript, Manifest V3.

```bash
pip install playwright && playwright install chromium
python3 e2e_test.py path/to/resume.pdf     # full flow in Chromium, AI calls stubbed
python3 check_resume.py path/to/resume.pdf --ollama gemma3:4b   # real resume extraction, local model
```

Open `test-form.html#selftest` in a browser for the in-page field detection and filling checks.

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Runs fills, keyboard shortcut, multi-page sessions, badge |
| `content.js` | Injected into pages: reads fields, fills them, watches for new steps |
| `llm.js` | Providers, resume parsing, field rules, the mapping prompt and guard |
| `options.*` | Profile, provider settings, resume upload |
| `popup.*` | Fill button, questions, session status |
| `tracker.*` | Applications list and CSV export |
| `vendor/` | pdf.js (Apache-2.0) |
