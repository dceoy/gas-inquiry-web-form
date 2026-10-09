import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { codeSource, createGas, GOOD_PROPERTIES } from "./harness.ts";

const source = new URL("../src/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, source), "utf8");

test("manifest: V8, anonymous deployer-executed web app, minimal scopes", () => {
  const manifest = JSON.parse(read("appsscript.json"));
  assert.equal(manifest.runtimeVersion, "V8");
  assert.deepEqual(manifest.webapp, {
    executeAs: "USER_DEPLOYING",
    access: "ANYONE_ANONYMOUS",
  });
  assert.deepEqual(manifest.oauthScopes, [
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/script.external_request",
  ]);
});

test("only deployable files live under src/", () => {
  assert.deepEqual(readdirSync(source).sort(), [
    "Code.js",
    "Index.html",
    "appsscript.json",
  ]);
});

test("only doGet and submitInquiry are callable via google.script.run", () => {
  const names = [...codeSource.matchAll(/^function\s+(\w+)/gm)].map(
    (m) => m[1],
  );
  const publicNames = names.filter((name) => !name?.endsWith("_"));
  assert.deepEqual(publicNames.sort(), ["doGet", "submitInquiry"]);
  const gas = createGas();
  for (const name of [
    "validatePayload_",
    "verifyTurnstile_",
    "loadConfig_",
    "reserve_",
    "buildBody_",
  ]) {
    assert.equal(typeof gas.global[name], "function", name);
  }
});

test("no top-level helper can send mail or read secrets without validation", () => {
  assert.doesNotMatch(codeSource, /^function\s+\w+[^_\w(]/m);
  assert.doesNotMatch(codeSource, /noReply/);
  assert.doesNotMatch(codeSource, /remoteip/);
  assert.doesNotMatch(codeSource, /getProperties\(\)/);
  assert.doesNotMatch(codeSource, /getOAuthToken/);
  assert.doesNotMatch(codeSource, /GmailApp/);
});

test("doGet serves the form, or a safe page when misconfigured, with a viewport tag", () => {
  const ok = createGas();
  ok.global.doGet();
  const configured = ok.outputs[0] as {
    kind: string;
    html: string;
    title: string;
    meta: Record<string, string>;
  };
  assert.equal(configured.kind, "Index");
  assert.match(configured.html, /"siteKey":"site-key"/);
  assert.match(configured.html, /"action":"inquiry"/);
  assert.doesNotMatch(configured.html, /secret-key|owner@example.com/);
  assert.equal(configured.title, "Inquiry");
  assert.equal(configured.meta.viewport, "width=device-width, initial-scale=1");

  const broken = createGas({ ...GOOD_PROPERTIES, TURNSTILE_SITE_KEY: "" });
  broken.global.doGet();
  const fallback = broken.outputs[0] as {
    kind: string;
    html: string;
    meta: Record<string, string>;
  };
  assert.equal(fallback.kind, "inline");
  assert.match(fallback.html, /temporarily unavailable/);
  assert.equal(fallback.meta.viewport, "width=device-width, initial-scale=1");
});

test("form: safe rendering and submit-state handling", () => {
  const page = read("Index.html");
  assert.match(
    page,
    /<main id="app" data-sitekey="<\?= siteKey \?>" data-action="<\?= action \?>">/,
  );
  assert.doesNotMatch(page, /<\?!=/);
  assert.doesNotMatch(
    page,
    /innerHTML|outerHTML|document\.write|insertAdjacentHTML/,
  );
  assert.match(page, /textContent/);
  assert.match(page, /withSuccessHandler/);
  assert.match(page, /withFailureHandler/);
  assert.match(page, /id="submit" type="submit" disabled/);
  assert.match(page, /expired-callback/);
  assert.match(page, /error-callback/);
  assert.match(page, /role="status"/);
  assert.doesNotMatch(page, /secret|EMAIL_TO/i);
});
