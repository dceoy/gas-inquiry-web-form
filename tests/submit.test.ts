import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGas,
  GOOD_PROPERTIES,
  SITEVERIFY_OK,
  VALID_PAYLOAD,
  type FetchReply,
} from "./harness.ts";

const valid = VALID_PAYLOAD;

test("accepted submission mails once with fixed recipient and Reply-To", () => {
  const gas = createGas();
  assert.deepEqual(gas.submit(valid), { ok: true });
  assert.equal(gas.mails.length, 1);
  assert.deepEqual(gas.mails[0], {
    to: "owner@example.com",
    subject: "New inquiry: Hello",
    body: "Name: Taro\nEmail: visitor@example.org\n\nFirst line\nSecond line",
    replyTo: "visitor@example.org",
  });
  assert.ok(!("noReply" in (gas.mails[0] ?? {})));
});

test("Siteverify request is fixed, bounded, and omits remoteip", () => {
  const gas = createGas();
  gas.submit(valid);
  const call = gas.fetchCalls[0];
  assert.equal(
    call?.url,
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  );
  assert.deepEqual(call?.options, {
    method: "post",
    payload: { secret: "secret-key", response: "token-1" },
    followRedirects: false,
    validateHttpsCertificates: true,
    muteHttpExceptions: true,
    timeoutSeconds: 10,
  });
});

const rejections: [string, FetchReply][] = [
  ["success false", { body: { ...SITEVERIFY_OK, success: false } }],
  [
    "expired/duplicate token",
    { body: { success: false, "error-codes": ["timeout-or-duplicate"] } },
  ],
  [
    "missing action",
    { body: { success: true, hostname: "abc123.example.net" } },
  ],
  ["wrong action", { body: { ...SITEVERIFY_OK, action: "other" } }],
  ["missing hostname", { body: { success: true, action: "inquiry" } }],
  [
    "unlisted hostname",
    { body: { ...SITEVERIFY_OK, hostname: "evil.example.net" } },
  ],
  [
    "suffix lookalike",
    { body: { ...SITEVERIFY_OK, hostname: "abc123.example.net.evil.com" } },
  ],
  [
    "prefix lookalike",
    { body: { ...SITEVERIFY_OK, hostname: "xabc123.example.net" } },
  ],
  [
    "subdomain of allowed",
    { body: { ...SITEVERIFY_OK, hostname: "a.abc123.example.net" } },
  ],
  [
    "shared googleusercontent host",
    { body: { ...SITEVERIFY_OK, hostname: "googleusercontent.com" } },
  ],
  ["hostname wrong type", { body: { ...SITEVERIFY_OK, hostname: 5 } }],
];

for (const [label, reply] of rejections) {
  test(`verification rejected: ${label}`, () => {
    const gas = createGas();
    gas.state.fetchDefault = reply;
    assert.deepEqual(gas.submit(valid), {
      ok: false,
      code: "VERIFICATION_FAILED",
    });
    assert.equal(gas.mails.length, 0);
  });
}

const upstreamErrors: [string, FetchReply][] = [
  ["HTTP 500", { status: 500, body: SITEVERIFY_OK }],
  ["HTTP 302", { status: 302, body: SITEVERIFY_OK }],
  ["HTTP 199", { status: 199, body: SITEVERIFY_OK }],
  ["malformed JSON", { rawBody: "<html>nope" }],
  ["JSON null", { rawBody: "null" }],
  ["JSON array", { rawBody: "[]" }],
  [
    "missing success",
    { body: { action: "inquiry", hostname: "abc123.example.net" } },
  ],
  ["fetch exception/timeout", { throws: true }],
];

for (const [label, reply] of upstreamErrors) {
  test(`upstream failure: ${label}`, () => {
    const gas = createGas();
    gas.state.fetchDefault = reply;
    assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
    assert.equal(gas.fetchCalls.length, 1, "no automatic retry");
    assert.equal(gas.mails.length, 0);
  });
}

test("hostname allowlist is case-insensitive and exact over all entries", () => {
  for (const hostname of ["ABC123.example.net", "other.example.net"]) {
    const gas = createGas();
    gas.state.fetchDefault = { body: { ...SITEVERIFY_OK, hostname } };
    assert.deepEqual(gas.submit(valid), { ok: true }, hostname);
  }
});

test("same token replayed: Siteverify duplicate rejection prevents a second mail", () => {
  const gas = createGas();
  const seen = new Set<string>();
  gas.state.onFetch = () => {
    const last = gas.fetchCalls[gas.fetchCalls.length - 1];
    const token = (last?.options.payload as { response: string } | undefined)
      ?.response as string;
    gas.state.fetchDefault = seen.has(token)
      ? { body: { success: false, "error-codes": ["timeout-or-duplicate"] } }
      : { body: SITEVERIFY_OK };
    gas.state.fetchReplies = [gas.state.fetchDefault];
    seen.add(token);
  };
  assert.deepEqual(gas.submit(valid), { ok: true });
  assert.deepEqual(gas.submit(valid), {
    ok: false,
    code: "VERIFICATION_FAILED",
  });
  assert.equal(gas.mails.length, 1);
  // A fresh challenge is a new submission and may repeat content.
  assert.deepEqual(gas.submit({ ...valid, turnstileToken: "token-2" }), {
    ok: true,
  });
  assert.equal(gas.mails.length, 2);
});

test("MailApp exception reports SEND_FAILED without retry or detail", () => {
  const gas = createGas();
  gas.state.mailThrows = true;
  const result = gas.submit(valid);
  assert.deepEqual(result, { ok: false, code: "SEND_FAILED" });
  assert.equal(gas.fetchCalls.length, 1);
  assert.equal(gas.mails.length, 0);
});

test("no external call happens while the script lock is held", () => {
  const gas = createGas();
  gas.submit(valid);
  assert.equal(gas.state.lockHeldDuringExternal, false);
  assert.equal(gas.state.lockHeld, false);
  assert.equal(gas.state.lockReleases, 2);
});

// --- bounded abuse controls ------------------------------------------------

test("verify limit: 10 per fixed UTC minute, then rollover", () => {
  const gas = createGas({ ...GOOD_PROPERTIES, MAX_MAIL_PER_DAY: "1000" });
  gas.state.fetchDefault = { body: { ...SITEVERIFY_OK, success: false } };
  for (let i = 0; i < 10; i += 1) {
    assert.equal(gas.submit(valid).ok, false);
  }
  assert.equal(gas.fetchCalls.length, 10);
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(
    gas.fetchCalls.length,
    10,
    "11th attempt never reaches Siteverify",
  );

  gas.state.now = "2026-10-09T12:34:59.999Z";
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  gas.state.now = "2026-10-09T12:35:00.000Z";
  gas.submit(valid);
  assert.equal(
    gas.fetchCalls.length,
    11,
    "new minute bucket replaces the old one",
  );
  assert.equal(gas.store.get("RL_VERIFY"), "2026-10-09T12:35:1");
});

test("verify limit counts failed attempts and honors the override", () => {
  const gas = createGas({ ...GOOD_PROPERTIES, MAX_VERIFY_PER_MINUTE: "2" });
  gas.state.fetchDefault = { status: 500 };
  gas.submit(valid);
  gas.submit(valid);
  assert.equal(gas.fetchCalls.length, 2);
  gas.state.fetchDefault = { body: SITEVERIFY_OK };
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(gas.mails.length, 0);
});

test("invalid input does not consume verify budget", () => {
  const gas = createGas();
  for (let i = 0; i < 30; i += 1) {
    gas.submit({ ...valid, email: "bad" });
  }
  assert.equal(gas.store.has("RL_VERIFY"), false);
});

test("mail limit: 20 per UTC day, then rollover", () => {
  const gas = createGas({ ...GOOD_PROPERTIES, MAX_VERIFY_PER_MINUTE: "1000" });
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(gas.submit({ ...valid, turnstileToken: `t${i}` }), {
      ok: true,
    });
  }
  assert.equal(gas.mails.length, 20);
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(gas.mails.length, 20);

  gas.state.now = "2026-10-09T23:59:59.999Z";
  assert.equal(gas.submit(valid).ok, false);
  gas.state.now = "2026-10-10T00:00:00.000Z";
  assert.deepEqual(gas.submit(valid), { ok: true });
  assert.equal(gas.mails.length, 21);
  assert.equal(gas.store.get("RL_MAIL"), "2026-10-10:1");
});

test("failed mail attempts stay counted against the daily cap", () => {
  const gas = createGas({ ...GOOD_PROPERTIES, MAX_MAIL_PER_DAY: "2" });
  gas.state.mailThrows = true;
  assert.equal(gas.submit(valid).ok, false);
  assert.equal(gas.submit(valid).ok, false);
  gas.state.mailThrows = false;
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(gas.mails.length, 0);
});

test("MailApp quota exhaustion stops before reserving or sending", () => {
  const gas = createGas();
  gas.state.mailQuota = 0;
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(gas.mails.length, 0);
  assert.equal(gas.store.has("RL_MAIL"), false);
});

test("lock failure fails closed with no external calls", () => {
  const gas = createGas();
  gas.state.lockAvailable = false;
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(gas.fetchCalls.length, 0);
  assert.equal(gas.mails.length, 0);
});

test("counter state failures and corruption fail closed and release the lock", () => {
  for (const mutate of [
    (gas: ReturnType<typeof createGas>) => {
      gas.state.storeThrows = true;
    },
    (gas: ReturnType<typeof createGas>) => {
      gas.store.set("RL_VERIFY", "garbage");
    },
  ]) {
    const gas = createGas();
    mutate(gas);
    assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
    assert.equal(gas.fetchCalls.length, 0);
    assert.equal(gas.mails.length, 0);
    assert.equal(gas.state.lockHeld, false);
  }
});

test("corrupt mail counter blocks mail after verification", () => {
  const gas = createGas();
  gas.store.set("RL_MAIL", "garbage");
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(gas.mails.length, 0);
  assert.equal(gas.state.lockHeld, false);
});

test("reservations are serialized by the script lock so limits cannot be exceeded", () => {
  // Counter writes throw unless the lock is held (see harness); a second
  // contender during a held lock is refused, never allowed to interleave.
  const gas = createGas({ ...GOOD_PROPERTIES, MAX_VERIFY_PER_MINUTE: "3" });
  gas.state.fetchDefault = { status: 500 };
  const results = Array.from({ length: 8 }, () => gas.submit(valid));
  assert.equal(gas.fetchCalls.length, 3);
  assert.equal(results.filter((r) => !r.ok).length, 8);
  assert.equal(gas.store.get("RL_VERIFY"), "2026-10-09T12:34:3");
});

test("logs contain only bounded categories, never user data or secrets", () => {
  const gas = createGas();
  gas.state.fetchDefault = { body: { ...SITEVERIFY_OK, success: false } };
  gas.submit(valid);
  gas.state.mailThrows = true;
  gas.state.fetchDefault = { body: SITEVERIFY_OK };
  gas.submit(valid);
  gas.submit({ ...valid, email: "bad" });
  assert.ok(gas.logs.length > 0);
  for (const line of gas.logs) {
    assert.match(line, /^inquiry:[a-z_]+$/);
  }
});

test("result objects never expose exceptions or configuration", () => {
  const gas = createGas();
  gas.state.mailThrows = true;
  const text = JSON.stringify([
    gas.submit(valid),
    gas.submit({ ...valid, email: "bad" }),
  ]);
  for (const secret of [
    "secret-key",
    "owner@example.com",
    "mail failure",
    "Error",
  ]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("contention: a request arriving while the lock is held is refused, never interleaved", () => {
  const gas = createGas({ ...GOOD_PROPERTIES, MAX_VERIFY_PER_MINUTE: "1" });
  let inner: unknown;
  gas.state.onCounterRead = () => {
    gas.state.onCounterRead = undefined;
    inner = gas.submit({ ...valid, turnstileToken: "token-2" });
  };
  assert.deepEqual(gas.submit(valid), { ok: true });
  assert.deepEqual(inner, { ok: false, code: "TRY_LATER" });
  assert.equal(gas.fetchCalls.length, 1);
  assert.equal(gas.mails.length, 1);
  assert.equal(gas.store.get("RL_VERIFY"), "2026-10-09T12:34:1");
  assert.equal(gas.state.lockHeld, false);
});

test("window boundary crossed while waiting for the lock cannot rewind the bucket", () => {
  const gas = createGas({ ...GOOD_PROPERTIES, MAX_VERIFY_PER_MINUTE: "1" });
  gas.store.set("RL_VERIFY", "2026-10-09T12:35:1");
  // The request starts in minute 12:34 but the lock wait ends in 12:35.
  gas.state.onTryLock = () => {
    gas.state.now = "2026-10-09T12:35:30.000Z";
  };
  assert.deepEqual(gas.submit(valid), { ok: false, code: "TRY_LATER" });
  assert.equal(gas.store.get("RL_VERIFY"), "2026-10-09T12:35:1");
  assert.equal(gas.fetchCalls.length, 0);
});
