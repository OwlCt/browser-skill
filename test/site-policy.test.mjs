import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInspectionLog } from "../src/inspection.mjs";
import { createSitePolicy } from "../src/site-policy.mjs";
import { assertNavigableUrl } from "../src/browser-tools.mjs";

test("public origins require an explicit site decision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-policy-"));
  const policy = createSitePolicy({ sitePolicy: "ask", allowedOrigins: new Set(), workspaceRoot: root });
  assert.throws(() => policy.check("https://example.com/path", assertNavigableUrl), /Site approval required/);
  policy.decide("https://example.com/path", "allow_once");
  assert.equal(policy.check("https://example.com/other", assertNavigableUrl), "https://example.com/other");
  assert.equal(policy.check("http://127.0.0.1:3000/app", assertNavigableUrl), "http://127.0.0.1:3000/app");
  policy.decide("https://blocked.example", "block");
  assert.throws(() => policy.check("https://blocked.example", assertNavigableUrl), /blocked/);
  policy.decide("https://kept.example", "allow");
  const reloaded = createSitePolicy({ sitePolicy: "ask", allowedOrigins: new Set(), workspaceRoot: root });
  assert.equal(reloaded.check("https://kept.example/a", assertNavigableUrl), "https://kept.example/a");
  assert.throws(() => reloaded.check("https://example.com", assertNavigableUrl), /Site approval required/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("allow mode and static origins keep their existing navigation rules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-policy-allow-"));
  const open = createSitePolicy({ sitePolicy: "allow", allowedOrigins: new Set(), workspaceRoot: root });
  assert.equal(open.check("https://example.com", assertNavigableUrl), "https://example.com/");
  const limited = createSitePolicy({
    sitePolicy: "ask",
    allowedOrigins: new Set(["https://example.com"]),
    workspaceRoot: root,
  });
  assert.equal(limited.check("https://example.com/in", assertNavigableUrl), "https://example.com/in");
  assert.throws(() => limited.check("https://other.example", assertNavigableUrl), /BROWSER_ALLOWED_ORIGINS/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("inspection records console and request metadata without bodies or secrets", () => {
  const log = createInspectionLog();
  log.console({
    type: () => "error",
    text: () => "boom",
    location: () => ({ url: "https://example.com/app?token=secret", lineNumber: 4 }),
  });
  const [message] = log.listConsole("error");
  assert.equal(message.text, "boom");
  assert.equal(message.line, 4);
  assert.match(message.url, /redacted/);
  assert.doesNotMatch(message.url, /secret/);

  const request = {
    method: () => "POST",
    url: () => "https://example.com/api?access_token=secret",
    resourceType: () => "fetch",
    failure: () => ({ errorText: "net::ERR" }),
  };
  log.request(request);
  log.response({ request: () => request, status: () => 201 });
  const [entry] = log.listNetwork(10);
  assert.equal(entry.method, "POST");
  assert.equal(entry.status, 201);
  assert.equal(entry.type, "fetch");
  assert.equal(entry.body, undefined);
  assert.match(entry.url, /redacted/);
  assert.doesNotMatch(JSON.stringify(entry), /secret/);
});
