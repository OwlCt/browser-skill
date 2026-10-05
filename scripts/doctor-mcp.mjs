import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";
import { loadMcpConfig } from "../src/mcp-config.mjs";
import { edgeLaunchArguments, findUserDataDirArgument, isCdpReady } from "../src/edge-session.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isolated = process.argv.includes("--isolated");
const runtimeConfig = loadMcpConfig();
let temporaryProfile;
const childEnv = { ...process.env };
if (isolated) {
  temporaryProfile = await fs.mkdtemp(path.join(os.tmpdir(), "edge-mcp-doctor-"));
  const portProbe = http.createServer();
  await new Promise((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolve);
  });
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  Object.assign(childEnv, {
    EDGE_CDP_URL: `http://127.0.0.1:${port}`,
    EDGE_USER_DATA_DIR: temporaryProfile,
    EDGE_AUTO_LAUNCH: "true",
    EDGE_REQUIRE_DEDICATED_PROFILE: "true",
    EDGE_KEEP_OPEN: "false",
    EDGE_HEADLESS: "true",
    EDGE_BRING_TO_FRONT: "false",
    EDGE_AUTO_CLOSE_TABS: "true",
    EDGE_CLEAR_SESSION_TABS_ON_START: "true",
    EDGE_TAB_IDLE_TIMEOUT_MS: "0",
    BROWSER_ARTIFACTS_DIR: path.join(temporaryProfile, "artifacts"),
  });
}
const config = loadMcpConfig(childEnv);
console.log(`MCP doctor: ${isolated ? "isolated" : "configured"} profile; headless=${config.headless}; keepOpen=${config.keepEdgeOpen}`);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-server.mjs")],
  cwd: projectRoot,
  env: childEnv,
  stderr: "pipe",
});
const client = new Client(
  { name: "responses-edge-browser-doctor", version: "1.0.0" },
  { capabilities: {} },
);
const secondTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-server.mjs")],
  cwd: projectRoot,
  env: childEnv,
  stderr: "pipe",
});
const secondClient = new Client(
  { name: "responses-edge-browser-doctor-second", version: "1.0.0" },
  { capabilities: {} },
);
for (const pipe of [transport.stderr, secondTransport.stderr]) {
  pipe?.on("data", (chunk) => process.stderr.write(chunk));
}

function toolJson(result, label) {
  const errorText = result.content?.find((item) => item.type === "text")?.text || "no error text";
  assert.equal(result.isError, undefined, `${label} failed: ${errorText}`);
  const content = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(content, `${label} returned no text state`);
  return JSON.parse(content);
}

const localServer = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (request.url === "/popup-one") {
    response.end(`<!doctype html><button id="next">Open next popup</button><script>
      document.querySelector('#next').addEventListener('click', () => window.open('/popup-two', '_blank'));
    </script>`);
    return;
  }
  if (request.url === "/popup-two") {
    response.end("<!doctype html><title>Final popup</title><main>done</main>");
    return;
  }
  response.end(`<!doctype html><button id="open">Open popup</button><script>
    document.querySelector('#open').addEventListener('click', () => window.open('/popup-one', '_blank'));
  </script>`);
});
await new Promise((resolve, reject) => {
  localServer.once("error", reject);
  localServer.listen(0, "127.0.0.1", resolve);
});
const localAddress = localServer.address();
const localOrigin = `http://127.0.0.1:${localAddress.port}`;
let firstClientClosed = false;
let screenshotArtifact;
let browser;
let diagnosticError;

try {
  await client.connect(transport);
  console.log("MCP handshake passed; checking browser navigation.");
  const initial = toolJson(await client.callTool({
    name: "browser_navigate",
    arguments: { url: `${localOrigin}/` },
  }), "MCP browser navigation");
  console.log("MCP browser navigation passed; checking popups and screenshot.");
  const openPopup = initial.elements.find((element) => element.name === "Open popup");
  assert.ok(openPopup?.ref, "Local popup button was not exposed as an interactive ref");
  const firstPopup = toolJson(await client.callTool({
    name: "browser_click",
    arguments: { ref: openPopup.ref },
  }), "First popup click");
  const openNextPopup = firstPopup.elements.find((element) => element.name === "Open next popup");
  assert.ok(openNextPopup?.ref, "First popup did not become the active session tab");
  const finalPopup = toolJson(await client.callTool({
    name: "browser_click",
    arguments: { ref: openNextPopup.ref },
  }), "Second popup click");
  assert.equal(new URL(finalPopup.url).pathname, "/popup-two", "Newest popup did not become the active tab");
  const tabs = toolJson(await client.callTool({
    name: "browser_tabs",
    arguments: { action: "list", tab_id: "", url: "" },
  }), "MCP browser tab list");
  assert.equal(tabs.tabs.length, 2, "Popup cleanup did not retain exactly the primary and newest popup tabs");
  const tabPaths = tabs.tabs.map((tab) => new URL(tab.url).pathname);
  assert.ok(tabPaths.includes("/popup-two"), "Newest popup was missing from the session tab list");
  assert.ok(!tabPaths.includes("/popup-one"), "Older implicit popup was not reclaimed");
  const screenshot = await client.callTool({
    name: "browser_screenshot",
    arguments: { full_page: false },
  });
  const screenshotMetadata = toolJson(screenshot, "Background MCP screenshot");
  assert.equal(new URL(screenshotMetadata.url).pathname, "/popup-two");
  screenshotArtifact = path.resolve(projectRoot, screenshotMetadata.artifact);
  const artifactRelative = path.relative(config.artifactsDir, screenshotArtifact);
  assert.ok(
    artifactRelative && !artifactRelative.startsWith("..") && !path.isAbsolute(artifactRelative),
    "Screenshot artifact escaped the configured artifacts directory",
  );
  const image = screenshot.content.find((item) => item.type === "image");
  assert.equal(image?.mimeType, "image/png", "Background screenshot returned no PNG image block");
  const pngBytes = Buffer.from(image.data, "base64");
  assert.ok(pngBytes.length > 8, "Background screenshot PNG was empty");
  assert.equal(pngBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(await isCdpReady(config.cdpUrl), true, "MCP Edge did not expose CDP");

  browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 15_000 });
  const cdpSession = await browser.newBrowserCDPSession();
  const commandLine = (await cdpSession.send("Browser.getBrowserCommandLine")).arguments;
  await cdpSession.detach();

  const actualProfile = path.resolve(findUserDataDirArgument(commandLine));
  assert.equal(actualProfile.toLowerCase(), config.edgeUserDataDir.toLowerCase());
  const expectedArguments = edgeLaunchArguments(config);
  for (const flag of ["--disable-extensions", "--disable-sync", "--enable-automation", "--headless=new"]) {
    if (!expectedArguments.includes(flag)) continue;
    assert.ok(commandLine.includes(flag), `Missing browser launch flag: ${flag}`);
  }
  assert.equal(commandLine.includes("--headless=new"), expectedArguments.includes("--headless=new"), "Running browser mode differs from configuration; relaunch the dedicated browser after changing its mode");
  const rawPageCount = () => browser.contexts()[0].pages().filter((page) => !page.isClosed()).length;
  const otherPageCount = rawPageCount() - 2;
  assert.ok(otherPageCount >= 0);
  if (isolated) assert.equal(otherPageCount, 0, "Raw Edge page count grew beyond the bounded popup policy");

  await secondClient.connect(secondTransport);
  toolJson(await secondClient.callTool({
    name: "browser_navigate",
    arguments: { url: `${localOrigin}/?client=second` },
  }), "Second MCP client navigation");
  const firstClientTabs = toolJson(await client.callTool({
    name: "browser_tabs",
    arguments: { action: "list", tab_id: "", url: "" },
  }), "First MCP client tab isolation");
  const secondClientTabs = toolJson(await secondClient.callTool({
    name: "browser_tabs",
    arguments: { action: "list", tab_id: "", url: "" },
  }), "Second MCP client tab isolation");
  assert.equal(firstClientTabs.tabs.length, 2, "First client lost ownership of its bounded tabs");
  assert.equal(secondClientTabs.tabs.length, 1, "Second client adopted tabs owned by another client");
  assert.equal(
    browser.contexts()[0].pages().filter((page) => !page.isClosed()).length,
    otherPageCount + 3,
    "Physical Edge tabs did not match the two isolated MCP sessions",
  );
  await client.close();
  firstClientClosed = true;
  assert.equal(await isCdpReady(config.cdpUrl), true, "First MCP client closed the shared Edge browser");
  const firstCloseDeadline = Date.now() + 3_000;
  while (
    Date.now() < firstCloseDeadline
    && rawPageCount() !== otherPageCount + 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    browser.contexts()[0].pages().filter((page) => !page.isClosed()).length,
    otherPageCount + 1,
    "First MCP client left owned physical tabs behind after closing",
  );
  toolJson(await secondClient.callTool({ name: "browser_snapshot", arguments: {} }), "Second client after first close");
} catch (error) {
  diagnosticError = error;
} finally {
  if (!firstClientClosed) await client.close().catch(() => {});
  await secondClient.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise((resolve) => localServer.close(resolve));
  if (screenshotArtifact) await fs.rm(screenshotArtifact, { force: true });
}

if (isolated) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await isCdpReady(config.cdpUrl, 250)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await isCdpReady(config.cdpUrl, 250)) {
    diagnosticError ||= new Error("MCP Edge remained open after the client closed");
    console.error(`Retaining the diagnostic profile because its browser is still running: ${temporaryProfile}`);
  } else {
    // Only remove the unique profile allocated by this run after CDP is closed.
    assert.equal(path.dirname(temporaryProfile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporaryProfile).startsWith("edge-mcp-doctor-"));
    await fs.rm(temporaryProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
} else {
  console.log(`Configured browser keepOpen=${runtimeConfig.keepEdgeOpen}; shared browser shutdown is checked with --isolated.`);
}
if (diagnosticError) throw diagnosticError;
console.log(`MCP Edge profile isolation passed: ${config.edgeUserDataDir}`);
