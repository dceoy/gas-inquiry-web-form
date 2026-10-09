/* global HtmlService, PropertiesService, LockService, UrlFetchApp, MailApp, console */
/* oxlint-disable no-unused-vars -- doGet and submitInquiry are called by the GAS runtime */

// Public entry points are `doGet` and `submitInquiry` only. Every other
// top-level function ends with `_`, which Apps Script hides from
// `google.script.run`. Keep it that way: tests enforce it.

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_SECONDS = 10;
const LOCK_WAIT_MS = 3000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_MAX_VERIFY_PER_MINUTE = 10;
const DEFAULT_MAX_MAIL_PER_DAY = 20;

const ALLOWED_FIELDS = [
  "name",
  "email",
  "subject",
  "message",
  "turnstileToken",
  "website",
];
// Raw (pre-trim) caps keep oversized input from reaching validation or
// external services; normalized limits are enforced separately.
const RAW_MAX_LENGTH = {
  name: 400,
  email: 1280,
  subject: 600,
  message: 8000,
  turnstileToken: 2048,
  website: 100,
};

// Whitespace, C0/C1 controls and address-list/header syntax are never allowed.
// oxlint-disable no-control-regex -- control characters are matched on purpose.
const EMAIL_PATTERN =
  /^[^\s\u0000-\u001f\u007f-\u009f<>,;()":\\@]+@[^\s\u0000-\u001f\u007f-\u009f<>,;()":\\@]+\.[^\s\u0000-\u001f\u007f-\u009f<>,;()":\\@]+$/;
const HEADER_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const ACTION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,8}$/;

/** Serve the inquiry form. */
function doGet() {
  let config;
  try {
    config = loadConfig_();
  } catch {
    log_("config_invalid");
    return page_(
      HtmlService.createHtmlOutput(
        "<!doctype html><p>This form is temporarily unavailable.</p>",
      ),
    );
  }
  const template = HtmlService.createTemplateFromFile("Index");
  template.siteKey = config.siteKey;
  template.action = config.action;
  return page_(template.evaluate());
}

/** Apps Script ignores <meta> in the file; the viewport must be added here. */
function page_(output) {
  return output
    .setTitle("Inquiry")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * Handle one inquiry from `google.script.run`.
 * @param {unknown} payload
 * @return {{ok: true} | {ok: false, code: string}}
 */
function submitInquiry(payload) {
  try {
    const fields = validatePayload_(payload);
    if (!fields) {
      return fail_("INVALID_INPUT");
    }
    const config = loadConfig_();

    if (!reserve_("RL_VERIFY", minuteBucket_, config.maxVerifyPerMinute)) {
      return fail_("TRY_LATER", "verify_limit");
    }
    const verdict = verifyTurnstile_(fields.turnstileToken, config);
    if (verdict === "upstream-error") {
      return fail_("TRY_LATER", "verify_upstream");
    }
    if (verdict === "rejected") {
      return fail_("VERIFICATION_FAILED", "verify_rejected");
    }

    if (MailApp.getRemainingDailyQuota() < 1) {
      return fail_("TRY_LATER", "mail_quota");
    }
    if (!reserve_("RL_MAIL", dayBucket_, config.maxMailPerDay)) {
      return fail_("TRY_LATER", "mail_limit");
    }
    try {
      MailApp.sendEmail({
        to: config.emailTo,
        subject: `New inquiry: ${fields.subject}`,
        body: buildBody_(fields),
        replyTo: fields.email,
      });
    } catch {
      return fail_("SEND_FAILED", "mail_error");
    }
    return { ok: true };
  } catch {
    // Config, lock, and state failures all fail closed without detail.
    return fail_("TRY_LATER", "internal_error");
  }
}

function fail_(code, category) {
  if (category) {
    log_(category);
  }
  return { ok: false, code };
}

/** Log a bounded diagnostic category only, never user data or secrets. */
function log_(category) {
  console.log(`inquiry:${category}`);
}

function isPlainObject_(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function utf8Length_(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Return normalized fields, or null when the payload is invalid. */
function validatePayload_(payload) {
  if (!isPlainObject_(payload)) {
    return null;
  }
  const keys = Object.keys(payload);
  if (keys.some((key) => !ALLOWED_FIELDS.includes(key))) {
    return null;
  }
  for (const key of keys) {
    const value = payload[key];
    if (typeof value !== "string" || value.length > RAW_MAX_LENGTH[key]) {
      return null;
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return null;
  }
  if (utf8Length_(serialized) > MAX_PAYLOAD_BYTES) {
    return null;
  }

  if ((payload.website ?? "") !== "") {
    return null;
  }

  const name = (payload.name ?? "").trim();
  if (name.length > 100) {
    return null;
  }

  if (typeof payload.email !== "string") {
    return null;
  }
  const email = payload.email.trim();
  if (email.length < 1 || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    return null;
  }

  if (typeof payload.subject !== "string") {
    return null;
  }
  if (HEADER_CONTROL_PATTERN.test(payload.subject)) {
    return null;
  }
  const subject = payload.subject.trim();
  if (subject.length < 1 || subject.length > 150) {
    return null;
  }

  if (typeof payload.message !== "string") {
    return null;
  }
  const message = payload.message.trim();
  if (message.length < 1 || message.length > 2000) {
    return null;
  }

  const token = payload.turnstileToken;
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 2048 ||
    /\s/.test(token)
  ) {
    return null;
  }

  return { name, email, subject, message, turnstileToken: token };
}

function buildBody_(fields) {
  return [
    `Name: ${fields.name || "(not provided)"}`,
    `Email: ${fields.email}`,
    "",
    fields.message,
  ].join("\n");
}

function parseLimit_(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error("invalid limit");
  }
  return Number(raw);
}

/** Read and validate Script Properties; throws when anything is malformed. */
function loadConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const read = (key) => (properties.getProperty(key) ?? "").trim();

  const emailTo = read("EMAIL_TO");
  if (!EMAIL_PATTERN.test(emailTo) || emailTo.length > 320) {
    throw new Error("invalid EMAIL_TO");
  }
  const siteKey = read("TURNSTILE_SITE_KEY");
  const secretKey = read("TURNSTILE_SECRET_KEY");
  if (!siteKey || !secretKey || /\s/.test(siteKey + secretKey)) {
    throw new Error("invalid Turnstile keys");
  }
  const action = read("TURNSTILE_ACTION");
  if (!ACTION_PATTERN.test(action)) {
    throw new Error("invalid TURNSTILE_ACTION");
  }
  const hostnames = read("TURNSTILE_HOSTNAMES")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase());
  if (
    hostnames.length === 0 ||
    hostnames.some(
      (hostname) => hostname.length > 253 || !HOSTNAME_PATTERN.test(hostname),
    )
  ) {
    throw new Error("invalid TURNSTILE_HOSTNAMES");
  }

  return {
    emailTo,
    siteKey,
    secretKey,
    action,
    hostnames,
    maxVerifyPerMinute: parseLimit_(
      properties.getProperty("MAX_VERIFY_PER_MINUTE"),
      DEFAULT_MAX_VERIFY_PER_MINUTE,
    ),
    maxMailPerDay: parseLimit_(
      properties.getProperty("MAX_MAIL_PER_DAY"),
      DEFAULT_MAX_MAIL_PER_DAY,
    ),
  };
}

function minuteBucket_() {
  return new Date().toISOString().slice(0, 16);
}

function dayBucket_() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomically reserve one attempt in a fixed-window counter stored as
 * "<bucket>:<count>" in a Script Property; `bucketOf` returns the current
 * window id and is called under the lock. The lock is held only around the
 * counter update, never around an external call. Returns false when the limit
 * is reached; throws on lock or state failure (callers fail closed). Failed
 * attempts stay counted: reservations are never refunded.
 */
function reserve_(key, bucketOf, limit) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    throw new Error("lock unavailable");
  }
  try {
    // Evaluate the window only after the lock wait so a boundary crossed while
    // waiting cannot overwrite a newer bucket with an older one.
    const bucket = bucketOf();
    const properties = PropertiesService.getScriptProperties();
    const stored = properties.getProperty(key);
    let count = 0;
    if (stored !== null && stored !== undefined) {
      const match = /^([0-9T:-]+):([0-9]+)$/.exec(stored);
      if (!match) {
        throw new Error("corrupt counter");
      }
      if (match[1] === bucket) {
        count = Number(match[2]);
      }
    }
    if (count >= limit) {
      return false;
    }
    properties.setProperty(key, `${bucket}:${count + 1}`);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** @return {"success" | "rejected" | "upstream-error"} */
function verifyTurnstile_(token, config) {
  let response;
  let body;
  try {
    // The visitor IP is deliberately not sent: neither client input nor Google's
    // outbound fetch IP identifies the visitor.
    response = UrlFetchApp.fetch(SITEVERIFY_URL, {
      method: "post",
      payload: { secret: config.secretKey, response: token },
      followRedirects: false,
      validateHttpsCertificates: true,
      muteHttpExceptions: true,
      timeoutSeconds: SITEVERIFY_TIMEOUT_SECONDS,
    });
    const status = response.getResponseCode();
    if (status < 200 || status > 299) {
      return "upstream-error";
    }
    body = JSON.parse(response.getContentText());
  } catch {
    return "upstream-error";
  }
  if (!isPlainObject_(body) || typeof body.success !== "boolean") {
    return "upstream-error";
  }
  const hostname =
    typeof body.hostname === "string" ? body.hostname.toLowerCase() : "";
  return body.success === true &&
    body.action === config.action &&
    config.hostnames.includes(hostname)
    ? "success"
    : "rejected";
}
