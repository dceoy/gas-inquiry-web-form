import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = new URL("../src/", import.meta.url);

test("GAS manifest selects the V8 runtime", () => {
  const manifest = JSON.parse(readFileSync(new URL("appsscript.json", source), "utf8"));
  assert.equal(manifest.runtimeVersion, "V8");
});

test("the web app entry point serves the HTML file", () => {
  const script = readFileSync(new URL("Code.js", source), "utf8");
  const page = readFileSync(new URL("Index.html", source), "utf8");
  assert.match(script, /function doGet\(\)/);
  assert.match(script, /HtmlService\.createHtmlOutputFromFile\("Index"\)/);
  assert.match(page, /<main>/);
});
