import assert from "node:assert/strict";
import { test } from "node:test";
import { createGas, GOOD_PROPERTIES, VALID_PAYLOAD } from "./harness.ts";

const valid = VALID_PAYLOAD;
const withField = (field: string, value: unknown) => ({
  ...valid,
  [field]: value,
});
const without = (field: string) => {
  const copy: Record<string, unknown> = { ...valid };
  delete copy[field];
  return copy;
};

const rejected: [string, unknown][] = [
  ["null payload", null],
  ["undefined payload", undefined],
  ["string payload", "hello"],
  ["array payload", [valid]],
  ["unexpected field", { ...valid, cc: "x@example.com" }],
  ["unexpected from field", { ...valid, from: "x@example.com" }],
  ["name wrong type", withField("name", 1)],
  ["name 101 chars", withField("name", "a".repeat(101))],
  ["email missing", without("email")],
  ["email wrong type", withField("email", 5)],
  ["email empty", withField("email", "")],
  ["email whitespace only", withField("email", "   ")],
  ["email 321 chars", withField("email", `${"a".repeat(310)}@example.org`)],
  ["email internal space", withField("email", "a b@example.org")],
  ["email newline", withField("email", "a@example.org\nBcc: x@example.net")],
  ["email comma list", withField("email", "a@example.org,b@example.org")],
  ["email semicolon list", withField("email", "a@example.org;b@example.org")],
  ["email angle brackets", withField("email", "<a@example.org>")],
  ["email display name", withField("email", "A <a@example.org>")],
  ["email two ats", withField("email", "a@b@example.org")],
  ["email no dot domain", withField("email", "a@example")],
  ["email control char", withField("email", "a\u0000@example.org")],
  ["subject missing", without("subject")],
  ["subject wrong type", withField("subject", {})],
  ["subject empty", withField("subject", "")],
  ["subject whitespace only", withField("subject", " \t ")],
  ["subject 151 chars", withField("subject", "s".repeat(151))],
  ["subject LF", withField("subject", "Hi\nBcc: x@example.net")],
  ["subject CR", withField("subject", "Hi\rBcc: x@example.net")],
  ["subject trailing LF (not stripped)", withField("subject", "Hi\n")],
  ["subject NUL", withField("subject", "Hi\u0000")],
  ["subject U+2028", withField("subject", "Hi x")],
  ["message missing", without("message")],
  ["message wrong type", withField("message", ["x"])],
  ["message empty", withField("message", "")],
  ["message whitespace only", withField("message", " \n ")],
  ["message 2001 chars", withField("message", "m".repeat(2001))],
  ["token missing", without("turnstileToken")],
  ["token wrong type", withField("turnstileToken", 1)],
  ["token empty", withField("turnstileToken", "")],
  ["token 2049 chars", withField("turnstileToken", "t".repeat(2049))],
  ["token whitespace", withField("turnstileToken", "to ken")],
  ["honeypot filled", withField("website", "http://spam.example")],
  ["honeypot wrong type", withField("website", 1)],
  // Raw (pre-trim) bound: 2000 chars of text plus huge padding is rejected.
  ["message raw size over cap", withField("message", `${" ".repeat(8000)}x`)],
  // Within raw length caps and valid once trimmed, but over 16 KiB as UTF-8.
  [
    "payload over 16 KiB UTF-8",
    withField("message", `${"\u3000".repeat(7000)}m`),
  ],
];

for (const [label, payload] of rejected) {
  test(`rejects: ${label}`, () => {
    const gas = createGas();
    assert.deepEqual(gas.submit(payload), {
      ok: false,
      code: "INVALID_INPUT",
    });
    assert.equal(gas.fetchCalls.length, 0);
    assert.equal(gas.mails.length, 0);
  });
}

const accepted: [string, unknown, Record<string, string>][] = [
  ["name omitted", without("name"), { name: "(not provided)" }],
  ["honeypot omitted", without("website"), {}],
  ["name empty", withField("name", ""), { name: "(not provided)" }],
  ["name exactly 100", withField("name", "n".repeat(100)), {}],
  ["name trimmed to 100", withField("name", ` ${"n".repeat(100)} `), {}],
  [
    "email exactly 320",
    withField("email", `${"a".repeat(64)}@${"b".repeat(251)}.org`),
    {},
  ],
  ["email trimmed", withField("email", "  visitor@example.org  "), {}],
  ["email apostrophe", withField("email", "o'brien@example.org"), {}],
  ["subject exactly 150", withField("subject", "s".repeat(150)), {}],
  ["subject single char", withField("subject", "x"), {}],
  [
    "subject Unicode counted by JS length",
    withField("subject", "件".repeat(150)),
    {},
  ],
  ["message exactly 2000", withField("message", "m".repeat(2000)), {}],
  ["message single char", withField("message", "m"), {}],
  [
    "message trimmed to 2000",
    withField("message", ` ${"m".repeat(2000)}\n`),
    {},
  ],
  ["token exactly 2048", withField("turnstileToken", "t".repeat(2048)), {}],
];

for (const [label, payload] of accepted) {
  test(`accepts: ${label}`, () => {
    const gas = createGas();
    assert.deepEqual(gas.submit(payload), { ok: true });
    assert.equal(gas.fetchCalls.length, 1);
    assert.equal(gas.mails.length, 1);
  });
}

test("preserves internal newlines, trims, and never alters the token", () => {
  const gas = createGas();
  const token = "abc.DEF-123_456";
  gas.submit({
    ...valid,
    message: "  a\n\nb  ",
    subject: "  Hi  ",
    turnstileToken: token,
  });
  const body = gas.mails[0]?.body as string;
  assert.ok(body.endsWith("\na\n\nb"));
  assert.equal(gas.mails[0]?.subject, "New inquiry: Hi");
  const payload = gas.fetchCalls[0]?.options.payload as Record<string, string>;
  assert.equal(payload.response, token);
});

test("invalid configuration makes zero external calls", () => {
  const bad: [string, Record<string, string>][] = [
    ["missing EMAIL_TO", { EMAIL_TO: "" }],
    ["list EMAIL_TO", { EMAIL_TO: "a@example.org,b@example.org" }],
    ["missing site key", { TURNSTILE_SITE_KEY: "" }],
    ["missing secret", { TURNSTILE_SECRET_KEY: "" }],
    ["missing action", { TURNSTILE_ACTION: "" }],
    ["bad action", { TURNSTILE_ACTION: "in quiry" }],
    ["missing hostnames", { TURNSTILE_HOSTNAMES: "" }],
    ["empty hostname entry", { TURNSTILE_HOSTNAMES: "a.example.net," }],
    ["wildcard hostname", { TURNSTILE_HOSTNAMES: "*.example.net" }],
    ["URL hostname", { TURNSTILE_HOSTNAMES: "https://a.example.net" }],
    ["hostname with path", { TURNSTILE_HOSTNAMES: "a.example.net/x" }],
    ["verify override zero", { MAX_VERIFY_PER_MINUTE: "0" }],
    ["verify override text", { MAX_VERIFY_PER_MINUTE: "ten" }],
    ["verify override decimal", { MAX_VERIFY_PER_MINUTE: "1.5" }],
    ["mail override negative", { MAX_MAIL_PER_DAY: "-3" }],
  ];
  for (const [label, override] of bad) {
    const gas = createGas({ ...GOOD_PROPERTIES, ...override });
    assert.deepEqual(
      gas.submit(valid),
      { ok: false, code: "TRY_LATER" },
      label,
    );
    assert.equal(gas.fetchCalls.length, 0, label);
    assert.equal(gas.mails.length, 0, label);
  }
});
