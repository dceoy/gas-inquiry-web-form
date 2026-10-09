# gas-inquiry-web-form

An anonymous inquiry web form on Google Apps Script (GAS). It serves the form
with HTML Service, verifies Cloudflare Turnstile on the server, and notifies one
fixed recipient with `MailApp` using the visitor's address as Reply-To.

The behavior and safeguards follow
[dceoy/cloudflare-inquiry-web-form](https://github.com/dceoy/cloudflare-inquiry-web-form)
(pinned at `73a5d79`), adapted to GAS. See [issue #1](https://github.com/dceoy/gas-inquiry-web-form/issues/1).

> **Status:** code and automated tests are complete. **Deployed acceptance is
> not done**: the real-iframe Turnstile hostname, signed-out `/exec` access and
> mailbox receipt have not been verified. See [docs/smoke-test.md](docs/smoke-test.md).
> Do not publish this form before that checklist is completed.

## How it works

- `doGet()` serves `src/Index.html` (sitekey and action are injected with
  contextually escaped `<?= ?>` scriptlets).
- The page calls one server function, `submitInquiry(payload)`, through
  `google.script.run`. There is no `doPost`, database, proxy, or visitor
  confirmation email.
- Every other top-level function ends with `_`, so it is not callable from the
  browser. Tests enforce that only `doGet` and `submitInquiry` are public.
- Order of checks: validate payload → read configuration → reserve a Siteverify
  attempt → verify the token (`success`, exact `action`, exact hostname) →
  check `MailApp.getRemainingDailyQuota()` → reserve a mail attempt → one
  `MailApp.sendEmail` call.
- Results are `{ok: true}` or `{ok: false, code}` with `code` one of
  `INVALID_INPUT`, `VERIFICATION_FAILED`, `TRY_LATER`, `SEND_FAILED`. Details are
  never returned; the browser shows fixed text.

### Validation

| Field | Requirement |
| --- | --- |
| `name` | optional, ≤ 100 chars after trim |
| `email` | 1–320 chars, one bare address; no whitespace/control chars, `,;<>():"\` |
| `subject` | 1–150 chars after trim; any control char (CR/LF…) in the raw value is rejected |
| `message` | 1–2000 chars after trim; internal newlines preserved |
| `turnstileToken` | opaque, 1–2048 chars, no whitespace; never altered |
| `website` | honeypot, must be empty or omitted |

Unexpected fields, non-string values, raw fields over their caps, and a
serialized payload over 16 KiB (UTF-8) are rejected before any external call.
Unlike a Worker, GAS has already received the input, so this is not an ingress
size guarantee.

## Development

Use Node.js 22.18+ and pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
```

Tests load `src/Code.js` into a `node:vm` context with mocked GAS services
(`PropertiesService`, `LockService`, `UrlFetchApp`, `MailApp`). They do not
establish real iframe or hostname compatibility.

## Deployment

Use **separate** GAS projects, Turnstile widgets/secrets, and mailboxes for test
and production. Deployments of one project share Script Properties and counters.

1. Create a standalone Apps Script project and copy `.clasp.example.json` to
   `.clasp.json` with its script ID (kept local, git-ignored).
2. `pnpm exec clasp login`, then `pnpm run push`. `rootDir` is `src/`, so tests,
   `.clasp.json` and credentials are never uploaded; `.claspignore` also
   excludes `*.test.*`, `*.md`, `*.map`, and dotfiles.
3. Create a Turnstile widget (use a real widget, not dummy keys) and set
   **Script Properties** (Project Settings → Script Properties):

   | Property | Meaning |
   | --- | --- |
   | `EMAIL_TO` | the one fixed recipient address |
   | `TURNSTILE_SITE_KEY` | widget sitekey (exposed to the browser) |
   | `TURNSTILE_SECRET_KEY` | widget secret (server only) |
   | `TURNSTILE_ACTION` | widget action, `[A-Za-z0-9_-]{1,32}` |
   | `TURNSTILE_HOSTNAMES` | comma-separated **exact** hostnames Siteverify may report |
   | `MAX_VERIFY_PER_MINUTE` | optional positive integer, default 10 |
   | `MAX_MAIL_PER_DAY` | optional positive integer, default 20 |

   Empty or malformed values (including a bad override) fail closed. Hostnames
   are lowercased and compared exactly; wildcards, URLs and paths are rejected.
   Cloudflare's own hostname setting also allows subdomains, so it does not
   replace this check. `TURNSTILE_HOSTNAMES` must come from smoke-test evidence
   (see below); do not approve all of `googleusercontent.com` or
   `script.google.com`.
4. In the editor, run `submitInquiry` once (or any function) as the deployer to
   authorize the two scopes: `script.send_mail` and `script.external_request`.
   No Gmail inbox access is requested.
5. Create a version and deploy. The manifest sets `executeAs: USER_DEPLOYING`
   and `access: ANYONE_ANONYMOUS`; confirm your Workspace policy permits it.

   ```bash
   pnpm exec clasp version "describe the change"
   pnpm exec clasp deploy --description "v1"                 # first deploy
   pnpm exec clasp deploy --deploymentId <ID> --versionNumber <N> --description "vN"  # update, keeps the /exec URL
   ```

   Test the versioned `/exec` URL signed out. `/dev` is editor-only and does not
   prove anonymous access.

### Disable or recover

- Stop accepting inquiries: `pnpm exec clasp undeploy <deploymentId>`, or delete
  `EMAIL_TO` (the form then shows "temporarily unavailable" and every submission
  returns `TRY_LATER`).
- Suspected token/secret leak: rotate the Turnstile secret and update
  `TURNSTILE_SECRET_KEY`.
- Counters (`RL_VERIFY`, `RL_MAIL`) are fixed-window values `<bucket>:<count>`.
  A corrupt value makes the limiter fail closed; delete the property to reset it.

## Abuse controls and limitations

- Global caps (not per visitor): 10 Siteverify attempts per fixed UTC minute and
  20 notification attempts per UTC day, kept in Script Properties under a
  `LockService` script lock that is never held during a fetch or send. Failed
  attempts are not refunded. These caps can also deny legitimate traffic; tune
  them with the overrides above.
- Mail is also stopped when `MailApp.getRemainingDailyQuota()` is 0. The
  application's UTC day is independent of Google's quota reset, and other
  scripts on the same account share Google's quota. See
  [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas);
  no sending allowance is guaranteed.
- Limits cannot prevent exhaustion of GAS invocations, concurrency, or other
  platform quotas.
- Success means the message was handed to `MailApp`, not that it reached an
  inbox. There are no automatic retries. A replayed Turnstile token is rejected
  by Siteverify (tokens are single-use and expire after five minutes) so it
  cannot trigger a second send; a **fresh** challenge is a new submission and
  may repeat the same content. Exactly-once delivery is not promised across
  execution termination or lost browser responses.
- Mail is sent as the deployer. There is no `noReply`, so Reply-To works.
- Logs contain only fixed categories (e.g. `inquiry:verify_rejected`).

`.github/` and the code-quality workflow are adapted from the Cloudflare
reference project.
