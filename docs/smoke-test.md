# Deployed smoke test (issue #1)

**Status: NOT PERFORMED.** The implementing session had no Apps Script
deployment credentials, no real Turnstile widget, and no test mailbox, so none
of the checks below ran. Deployed acceptance for issue #1 is incomplete.

Dummy Turnstile keys and the local mocks do not establish production iframe or
hostname compatibility. Record sanitized evidence only: no secrets, tokens,
script IDs or mailbox addresses.

## Blocking decision before production

`TURNSTILE_HOSTNAMES` cannot be chosen until Siteverify reports a stable,
deployment-specific hostname from the real GAS sandboxed iframe. If only a
shared or unstable hostname (e.g. a generic `googleusercontent.com` host) is
reported, stop and resolve the security/hosting decision. Do not loosen the
check or remove Turnstile.

## Record

| Field | Value |
| --- | --- |
| Date | |
| Test project / version / deployment | |
| Browsers and sessions | |
| Siteverify `hostname` (sanitized) | |
| Siteverify `action` | |
| Hostname stable across reloads / other browser / version update? | |

## Checklist

- [ ] Signed-out access to the versioned `/exec` URL (no Google sign-in)
- [ ] Turnstile widget loads inside the GAS iframe; iframe hostname recorded
- [ ] Real challenge succeeds; Siteverify `success`, `action`, `hostname` recorded
- [ ] Mailbox receipt with working Reply-To to the visitor address
- [ ] Hostname and action unchanged after reload, another browser/session, and a version update
- [ ] Invalid input and honeypot rejected with safe text and no mail
- [ ] Rejected/bot verification returns a safe error and no mail
- [ ] Expired challenge: UI recovers and a new challenge allows submission
- [ ] Double click sends at most one mail (single-use token)
- [ ] Generic failure text and UI recovery (fields preserved on failure, cleared on success)
