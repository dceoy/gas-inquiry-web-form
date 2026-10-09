# gas-inquiry-web-form

An inquiry web form built with Google Apps Script (GAS).

> **Status:** Project scaffold only. Form submission, Cloudflare Turnstile verification,
> and Gmail notification are planned in [issue #1](https://github.com/dceoy/gas-inquiry-web-form/issues/1).
> The placeholder web page does **not** accept inquiries yet.

The behavior and safeguards are based on
[dceoy/cloudflare-inquiry-web-form](https://github.com/dceoy/cloudflare-inquiry-web-form).
This version will use GAS HTML Service and MailApp instead of Cloudflare Workers and Resend.

## Development

Use Node.js 22.18+ and pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
```

## GAS setup

1. Create a standalone Apps Script project in the [Apps Script editor](https://script.google.com/).
2. Copy `.clasp.example.json` to `.clasp.json` and replace `REPLACE_WITH_YOUR_SCRIPT_ID` with the project's script ID. Keep `.clasp.json` local.
3. Authenticate with `pnpm exec clasp login` and upload the `src/` files using `pnpm run push`.
4. For a preliminary browser test, deploy it as a Web App in the Apps Script editor. Select **Execute as: Me** and configure access only after reviewing your Workspace policies. This placeholder contains no email-sending capability.

The project is not production-ready. When implementation of issue #1 is complete,
configure Turnstile, Script Properties, authorization, mail quotas and access restrictions before public release.

`.github/` and the code-quality workflow are adapted from the Cloudflare reference project.
