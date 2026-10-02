# Security Audit

## Assessment record

- Project: ContextFill browser extension
- Assessment date: 2026-10-02
- Assessment type: Application security code review
- Reviewed revision: `24cbb92262e844cd7f7e6a61a8f23807c9e6c185` (`main`)
- Scope: Manifest V3 configuration, extension pages, service worker, content script, AI-provider calls, resume parsing, bundled PDF.js metadata, and the Playwright end-to-end test.

Security vulnerabilities identified during the Codex-assisted security review were analyzed, remediated, and validated through code review and security testing. This assessment does not guarantee the application is secure against all future vulnerabilities.

## Application and trust boundaries

ContextFill is a Manifest V3 Chrome/Safari extension that reads visible fields from a user-selected job-application page, combines those fields with a locally stored candidate profile, and uses Groq, Claude, or a local Ollama model to propose values. The user reviews values and submits the form. The service worker injects the content script into the active tab, applies values, and stores application-tracker data. Resume PDFs are parsed locally with bundled PDF.js; their extracted text and form metadata are sent to the selected remote provider when Groq or Claude is used.

Primary trust boundaries are: page DOM and field text (untrusted), model output (untrusted), extension storage (contains profile data, resume content, and API keys), the selected AI provider, and the local Ollama endpoint. The extension does not implement its own login, server-side API, database, or background jobs.

## Findings

| ID | Finding | Severity | CWE | Location | Status |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | Persistent all-sites host permission | Medium | CWE-250 | `manifest.json` | Fixed |
| SEC-002 | Excessive page data sent to AI model and model-output control gap | Medium | CWE-200 / CWE-20 | `content.js`, `llm.js` | Fixed |
| SEC-003 | Unsafe local-model endpoint and unbounded resume processing | Low | CWE-918 / CWE-400 | `llm.js`, `options.js` | Fixed |

### SEC-001 Persistent all-sites host permission

**Classification:** Confirmed security weakness. **OWASP:** A05 Security Misconfiguration. **Affected component:** extension manifest. **Root cause:** `<all_urls>` was granted as a persistent host permission even though form interaction starts from an explicit user action and can use `activeTab`.

**Attack scenario and impact:** A future extension defect or compromise would have standing access across the user’s browsing sessions instead of the active, user-invoked tab. This enlarged the accessible data and site surface beyond the extension’s intended workflow.

**Remediation:** Replaced the blanket permission with explicit Groq, Anthropic, and loopback Ollama hosts. Form access remains user-initiated through `activeTab`.

**Validation:** Manifest loaded successfully in Chromium during the end-to-end run; the active-tab fill and same-origin multi-step flow both passed.

### SEC-002 Excessive page data sent to AI model and model-output control gap

**Classification:** Confirmed data-exposure and input-validation weakness. **OWASP:** A04 Insecure Design and A05 Security Misconfiguration. **Affected components:** page scanner and model mapper. **Root cause:** The scanner included up to 4,000 characters of arbitrary page transcript in each model request. Model-returned field ids were accepted without rejecting duplicate or unknown ids, and sensitive identity, financial, and authentication field labels could reach the model.

**Attack scenario and impact:** A page can contain unrelated sensitive information or prompt-like text. It would have been forwarded to the selected model provider, and a model response could attempt to apply more than one action to a field. This increased privacy exposure and made prompt-influenced output less constrained.

**Remediation:** Send only page URL and title with field metadata; instruct the model that page and field text is untrusted data; accept only the first result for each scanned field; discard unknown and duplicate ids; and route password, one-time code, identity-document, financial-account/card, and date-of-birth fields to a user-entered prompt without sending them to the model.

**Validation:** End-to-end assertions verify that page transcript text is absent, a National ID field is not model-mapped, and duplicate/unknown model ids are removed. The full fill flow passed.

### SEC-003 Unsafe local-model endpoint and unbounded resume processing

**Classification:** Confirmed defense-in-depth weakness. **OWASP:** A10 Server-Side Request Forgery and A04 Insecure Design. **Affected components:** Ollama configuration and PDF text extraction. **Root cause:** The Ollama setting was interpolated into fetch URLs without restricting it to a loopback endpoint; resume processing imposed no input-size, page-count, or text-extraction limit.

**Attack scenario and impact:** A misconfigured or tampered setting could cause the extension to transmit profile and resume data to an arbitrary endpoint. A very large resume could consume excessive browser memory and processing time.

**Remediation:** Allow only `http` loopback origins (`localhost`, `127.0.0.1`, `[::1]`) with no credentials, path, query, or fragment. Reject invalid settings in both model discovery and save flows. Enforce 10 MB, 50-page, and 500,000-character resume limits, and explicitly disable PDF scripting.

**Validation:** The end-to-end suite verifies a loopback URL is accepted and a remote URL is rejected. Syntax checks passed and the normal upload-to-fill flow passed with a local fixture.

## Dependency review

The repository has no package manifest or lockfile. It bundles PDF.js `6.3.289`. The review checked the current Mozilla advisory for CVE-2026-16633: its listed patched version is `6.2.108`, so the bundled version is not recorded as affected by that advisory. PDF scripting is nevertheless disabled explicitly while processing resumes. No confirmed dependency vulnerability was identified from the inspected dependency set.

## Validation performed

| Check | Result |
| --- | --- |
| JavaScript syntax checks for extension scripts | Passed |
| Python bytecode compilation for test utilities | Passed |
| `git diff --check` | Passed |
| Playwright end-to-end workflow with local text fixture | Passed |
| Second targeted code review of permissions, model boundary, and input handling | Passed; no new confirmed finding |

The live Ollama check ran because a local model was available during the test. No live Groq or Claude credentials were used; those provider interactions were stubbed by the test harness.

## Remaining risks and recommendations

- Remote AI providers necessarily receive the profile, resume text, and field metadata needed for mapping. Users should select providers deliberately and avoid submitting sensitive data to third-party pages.
- Browser extension storage protects data from ordinary web pages but is not application-level encryption. Keep the browser profile and extension set trusted.
- The label-based sensitive-field classifier is conservative but cannot replace user review. The extension intentionally does not submit forms automatically.
- Add a repeatable dependency update/check process for bundled PDF.js, and rerun the security suite when provider APIs or extension permissions change.
- Manual penetration testing remains appropriate for production release, especially against hostile application pages and browser-specific Safari behavior.
