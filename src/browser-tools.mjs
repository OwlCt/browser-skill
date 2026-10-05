import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describeRuntime, planRuntimeChange, saveRuntimeState } from "./browser-runtime.mjs";
import { collectFrameState } from "./frame-state.mjs";
import { createSitePolicy } from "./site-policy.mjs";

const functionTool = (name, description, properties, required = Object.keys(properties)) => ({
  type: "function",
  name,
  description,
  strict: true,
  parameters: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});

export const browserToolDefinitions = [
  functionTool(
    "browser_snapshot",
    "Read the active page's URL, title, visible text, scroll state, and interactive elements. Returns refs such as e1 for later actions.",
    {},
    [],
  ),
  functionTool(
    "browser_navigate",
    "Navigate the active Edge tab to an absolute HTTP(S) URL and return the new page state.",
    { url: { type: "string", description: "Absolute HTTP(S) URL." } },
  ),
  functionTool(
    "browser_click",
    "Click an interactive element from the latest page state and return the resulting page state.",
    { ref: { type: "string", description: "Element ref from browser_snapshot, for example e3." } },
  ),
  functionTool(
    "browser_type",
    "Replace the text in an editable element. Password fields are blocked. Optionally press Enter after filling.",
    {
      ref: { type: "string", description: "Editable element ref from the latest page state." },
      text: { type: "string", description: "Text to enter." },
      submit: { type: "boolean", description: "Press Enter after filling." },
    },
  ),
  functionTool(
    "browser_press",
    "Press a Playwright key such as Enter, Escape, ArrowDown, or Control+A on a referenced element.",
    {
      ref: { type: "string", description: "Element ref from the latest page state." },
      key: { type: "string", description: "Playwright key name or chord." },
    },
  ),
  functionTool(
    "browser_select",
    "Choose a select element option by its option value and return the resulting page state.",
    {
      ref: { type: "string", description: "Select element ref from the latest page state." },
      value: { type: "string", description: "Exact option value shown in the page state." },
    },
  ),
  functionTool(
    "browser_scroll",
    "Scroll the active page vertically and return the resulting page state.",
    {
      direction: { type: "string", enum: ["up", "down"] },
      amount: { type: "integer", minimum: 50, maximum: 3000, description: "Pixels to scroll." },
    },
  ),
  functionTool(
    "browser_wait",
    "Wait for a page condition, then return the page state. Use text, url, or load_state. milliseconds is the timeout. With no condition, it waits for that many milliseconds.",
    {
      milliseconds: { type: "integer", minimum: 0, maximum: 30000 },
      text: { type: "string", description: "Visible text to wait for. Empty skips this condition." },
      url: { type: "string", description: "URL or substring to wait for. Empty skips this condition." },
      load_state: { type: "string", enum: ["none", "domcontentloaded", "load", "networkidle"] },
    },
  ),
  functionTool(
    "browser_hover",
    "Hover an element from the latest page state.",
    { ref: { type: "string", description: "Element ref from browser_snapshot." } },
  ),
  functionTool(
    "browser_double_click",
    "Double-click an element from the latest page state.",
    { ref: { type: "string", description: "Element ref from browser_snapshot." } },
  ),
  functionTool(
    "browser_file",
    "Choose a local file for a file input. The file is uploaded to the page and is not read back.",
    {
      ref: { type: "string", description: "File input ref from browser_snapshot." },
      path: { type: "string", description: "Absolute file path, or a path relative to the project." },
    },
  ),
  functionTool(
    "browser_dialog",
    "Arm the response for the next alert, confirm, or prompt. Unarmed dialogs are dismissed so the page does not stay stuck. Accept only when the user asked for that dialog.",
    {
      action: { type: "string", enum: ["status", "arm"] },
      decision: { type: "string", enum: ["keep", "accept", "dismiss"] },
      prompt_text: { type: "string", description: "Text to enter when accepting a prompt. Empty otherwise." },
    },
  ),
  functionTool(
    "browser_history",
    "Go back or reload the active page and return the new page state.",
    { action: { type: "string", enum: ["back", "reload"] } },
  ),
  functionTool(
    "browser_tabs",
    "List, create, switch, or close tabs owned by this MCP session. Explicitly created tabs remain available until closed or the session becomes idle.",
    {
      action: { type: "string", enum: ["list", "new", "switch", "close"] },
      tab_id: { type: "string", description: "Tab id such as t1, or an empty string." },
      url: { type: "string", description: "HTTP(S) URL for a new tab, or an empty string." },
    },
  ),
  functionTool(
    "browser_screenshot",
    "Capture the active page. Returns an inline image only when BROWSER_INLINE_SCREENSHOTS=true; otherwise returns the saved artifact name.",
    { full_page: { type: "boolean" } },
  ),
  functionTool(
    "browser_runtime",
    "Read or apply the browser launch. Pass keep for any field that should stay unchanged. browser is edge or chrome. Headless, extensions, stealth, browser, and profile take effect on the next managed launch. bring_to_front and window apply to the current window. attach connects to an already listening loopback browser and does not close it. Experimental stealth only omits --enable-automation. It does not change the user agent, Canvas, or WebGL, and it does not guarantee passing Cloudflare. Changing to a user or custom profile requires confirm_external_profile true.",
    {
      action: { type: "string", enum: ["status", "apply"] },
      browser: { type: "string", enum: ["keep", "edge", "chrome"] },
      headless: { type: "string", enum: ["keep", "true", "false"] },
      load_extensions: { type: "string", enum: ["keep", "true", "false"] },
      stealth: { type: "string", enum: ["keep", "true", "false"] },
      bring_to_front: { type: "string", enum: ["keep", "true", "false"] },
      window: { type: "string", description: "keep, default, or WIDTHxHEIGHT such as 1280x720." },
      connection_mode: { type: "string", enum: ["keep", "managed", "attach"] },
      profile_target: { type: "string", enum: ["keep", "dedicated", "user", "custom"] },
      profile_directory: { type: "string", description: "Default or Profile N. Empty keeps the current name." },
      user_data_dir: { type: "string", description: "Absolute user data directory for custom. Empty keeps the current directory." },
      cdp_url: { type: "string", description: "Loopback CDP URL. Empty keeps the current URL." },
      confirm_external_profile: { type: "string", enum: ["keep", "true", "false"] },
    },
  ),
  functionTool(
    "browser_console",
    "Read recent console messages and page errors. This does not execute page script or return network bodies.",
    {
      action: { type: "string", enum: ["list", "clear"] },
      level: { type: "string", enum: ["all", "error", "warning", "info", "log"] },
    },
  ),
  functionTool(
    "browser_network",
    "Read recent request metadata: method, URL, resource type, and status. Bodies, cookies, and headers are not returned.",
    {
      action: { type: "string", enum: ["list", "clear"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  ),
  functionTool(
    "browser_styles",
    "Read a fixed set of computed styles and a short node description for one element ref.",
    { ref: { type: "string", description: "Element ref from browser_snapshot." } },
  ),
  functionTool(
    "browser_site",
    "Approve or block a website origin. Use this only after the user explicitly chooses. allow_once lasts for this session. allow and block are remembered. Loopback origins are allowed without a prompt.",
    {
      action: { type: "string", enum: ["status", "decide"] },
      origin: { type: "string", description: "Origin such as https://example.com. Empty for status." },
      decision: { type: "string", enum: ["keep", "allow_once", "allow", "block"] },
    },
  ),
  functionTool(
    "browser_handoff",
    "Pause automated actions so a person can finish a verification challenge in the same browser window, then resume in that session. Do not try to solve the challenge.",
    { action: { type: "string", enum: ["status", "pause", "resume"] } },
  ),
];

const VERIFICATION_URL = /challenges\.cloudflare\.com|\/cdn-cgi\/challenge/i;
const VERIFICATION_TEXT = /just a moment|verify you are human|performing security verification|cf-browser-verification|captcha|recaptcha|hcaptcha|turnstile/i;

export function pageNeedsManualVerification(url, title, text, elements = []) {
  const haystack = `${title || ""}\n${text || ""}`.slice(0, 4000);
  if (VERIFICATION_URL.test(url || "") || VERIFICATION_TEXT.test(`${url || ""}\n${haystack}`)) return "verification";
  if (elements.some((element) => element?.type === "password")) return "sign-in";
  return "";
}

export function parseElementRef(ref) {
  const match = /^(?:f(\d+))?(e\d+)$/.exec(String(ref || ""));
  if (!match) return null;
  const frameIndex = match[1] ? Number(match[1]) - 1 : 0;
  if (frameIndex < 0) return null;
  return { frameIndex, localRef: match[2] };
}

export function resolveUploadPath(filePath, workspaceRoot = process.cwd()) {
  const requested = String(filePath || "").trim();
  if (!requested) throw new Error("browser_file requires a file path.");
  const absolute = path.resolve(workspaceRoot || process.cwd(), requested);
  let stat;
  try {
    stat = fsSync.statSync(absolute);
  } catch {
    throw new Error(`File does not exist: ${absolute}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${absolute}`);
  return absolute;
}

const SENSITIVE_QUERY_KEY = /(access|auth|code|credential|jwt|key|password|secret|session|signature|token)/i;

export function sanitizeUrlForModel(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}

export function assertNavigableUrl(rawUrl, allowedOrigins = new Set()) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Navigation requires an absolute HTTP(S) URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Navigation protocol ${url.protocol} is blocked; only HTTP(S) is allowed.`);
  }
  if (url.username || url.password) {
    throw new Error("URLs containing embedded credentials are blocked.");
  }
  if (allowedOrigins.size > 0 && !allowedOrigins.has(url.origin)) {
    throw new Error(`Origin ${url.origin} is not in BROWSER_ALLOWED_ORIGINS.`);
  }
  return url.href;
}

async function settle(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(150).catch(() => {});
}

export class BrowserTools {
  constructor(session, config, hooks = {}) {
    this.session = session;
    this.config = config;
    this.hooks = hooks;
    this.definitions = browserToolDefinitions;
    this.manualPause = null;
    this.sitePolicy = hooks.sitePolicy || createSitePolicy(config);
  }

  #approvedUrl(rawUrl) {
    return this.sitePolicy.check(rawUrl, assertNavigableUrl);
  }

  #assertAutomated() {
    if (!this.manualPause) return;
    throw new Error("Automated actions are paused so a person can finish verification in the browser window. Call browser_handoff resume after it is done.");
  }

  async snapshot() {
    const page = this.session.page();
    await settle(page);

    const state = await this.#readPageState(page);
    const url = page.url();
    const report = {
      ok: true,
      tabId: this.session.tabId(page),
      url: sanitizeUrlForModel(url),
      ...state,
    };
    const pauseReason = pageNeedsManualVerification(url, state.title, state.text, state.elements);
    if (pauseReason) {
      this.manualPause = {
        reason: this.manualPause?.reason || pauseReason,
        url: report.url,
      };
    }
    report.needsUser = Boolean(this.manualPause);
    report.manualPause = this.manualPause;
    if (this.session.lastDialog) report.dialog = this.session.lastDialog;
    if (this.session.consumeDownloads) {
      const downloads = this.session.consumeDownloads();
      if (downloads.length > 0) report.downloads = downloads;
    }
    return report;
  }

  async #readPageState(page) {
    const limits = { maxTextChars: this.config.maxTextChars, maxElements: 200 };
    const frames = typeof page.frames === "function"
      ? page.frames().filter((frame) => !frame.isDetached?.())
      : [];
    if (frames.length <= 1) return (frames[0] || page).evaluate(collectFrameState, limits);

    const inaccessibleFrames = [];
    const elements = [];
    let main = null;
    for (let index = 0; index < frames.length && elements.length < 200; index += 1) {
      try {
        const local = await frames[index].evaluate(collectFrameState, {
          maxTextChars: index === 0 ? limits.maxTextChars : 1_000,
          maxElements: 200 - elements.length,
        });
        const prefix = index === 0 ? "" : `f${index + 1}`;
        for (const element of local.elements) element.ref = `${prefix}${element.ref}`;
        elements.push(...local.elements);
        if (index === 0) main = local;
      } catch {
        inaccessibleFrames.push(sanitizeUrlForModel(frames[index].url?.() || ""));
      }
    }
    return {
      title: main?.title || "",
      text: main?.text || "",
      textTruncated: Boolean(main?.textTruncated),
      viewport: main?.viewport || { width: 0, height: 0, scrollY: 0, pageHeight: 0 },
      elements,
      inaccessibleFrames,
    };
  }

  locatorForRef(ref) {
    const parsed = parseElementRef(ref);
    if (!parsed) throw new Error(`Invalid element ref: ${ref}`);
    const page = this.session.page();
    const frames = typeof page.frames === "function" ? page.frames() : [];
    const scope = frames[parsed.frameIndex] || (parsed.frameIndex === 0 ? page : null);
    if (!scope) throw new Error(`Element ref ${ref} is stale or missing. Run browser_snapshot and use a current ref.`);
    return scope.locator(`[data-responses-ref="${parsed.localRef}"]`);
  }

  async assertRefAvailable(ref) {
    const locator = this.locatorForRef(ref);
    if (await locator.count() !== 1) {
      throw new Error(`Element ref ${ref} is stale or missing. Run browser_snapshot and use a current ref.`);
    }
    return locator;
  }

  async afterAction() {
    await this.session.settlePopups();
    const page = this.session.page();
    await this.session.maybeBringToFront(page);
    return this.snapshot();
  }

  async navigate({ url }) {
    const target = this.#approvedUrl(url);
    const page = this.session.page();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (/^https?:/i.test(page.url())) this.#approvedUrl(page.url());
    return this.afterAction();
  }

  async click({ ref }) {
    const locator = await this.assertRefAvailable(ref);
    await locator.click({ timeout: 15_000 });
    return this.afterAction();
  }

  async hover({ ref }) {
    const locator = await this.assertRefAvailable(ref);
    await locator.hover({ timeout: 15_000 });
    return this.afterAction();
  }

  async doubleClick({ ref }) {
    const locator = await this.assertRefAvailable(ref);
    await locator.dblclick({ timeout: 15_000 });
    return this.afterAction();
  }

  async file({ ref, path: filePath }) {
    const absolute = resolveUploadPath(filePath, this.config.workspaceRoot);
    const locator = await this.assertRefAvailable(ref);
    await locator.setInputFiles(absolute);
    const report = await this.afterAction();
    report.file = path.basename(absolute);
    return report;
  }

  async type({ ref, text, submit }) {
    const locator = await this.assertRefAvailable(ref);
    const inputType = (await locator.getAttribute("type"))?.toLowerCase();
    if (inputType === "password") {
      throw new Error("Typing into password fields is blocked. Enter passwords manually in Edge.");
    }
    await locator.fill(text, { timeout: 15_000 });
    if (submit) await locator.press("Enter");
    return this.afterAction();
  }

  async press({ ref, key }) {
    if (!/^[A-Za-z0-9+_-]{1,60}$/.test(key)) {
      throw new Error("Invalid Playwright key name.");
    }
    const locator = await this.assertRefAvailable(ref);
    await locator.press(key);
    return this.afterAction();
  }

  async select({ ref, value }) {
    const locator = await this.assertRefAvailable(ref);
    await locator.selectOption({ value });
    return this.afterAction();
  }

  async scroll({ direction, amount }) {
    const bounded = Math.min(3_000, Math.max(50, Number(amount)));
    await this.session.page().mouse.wheel(0, direction === "up" ? -bounded : bounded);
    return this.afterAction();
  }

  async wait({ milliseconds, text = "", url = "", load_state: loadState = "none" }) {
    const page = this.session.page();
    const hasCondition = Boolean(text || url || (loadState && loadState !== "none"));
    const timeout = Math.min(30_000, Math.max(100, Number(milliseconds) || (hasCondition ? 10_000 : 100)));
    if (!hasCondition) {
      await page.waitForTimeout(timeout);
      return this.afterAction();
    }
    if (loadState && !["none", "domcontentloaded", "load", "networkidle"].includes(loadState)) {
      throw new Error("load_state must be none, domcontentloaded, load, or networkidle.");
    }
    const pending = [];
    if (text) {
      pending.push(page.waitForFunction((needle) => (
        (document.body?.innerText || "").includes(needle)
      ), text, { timeout }));
    }
    if (url) {
      let target;
      try {
        target = new URL(url);
      } catch {
        target = null;
      }
      if (target && !["http:", "https:"].includes(target.protocol)) {
        throw new Error("browser_wait url must be an HTTP(S) URL or a substring.");
      }
      pending.push(page.waitForURL((current) => (
        target ? current.href.startsWith(target.href) : current.href.includes(url)
      ), { timeout }));
    }
    if (loadState && loadState !== "none") pending.push(page.waitForLoadState(loadState, { timeout }));
    try {
      await Promise.all(pending);
    } catch (error) {
      throw new Error(`Timed out waiting for the page condition: ${error.message}`);
    }
    return this.afterAction();
  }

  async history({ action }) {
    const page = this.session.page();
    if (action === "back") {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    return this.afterAction();
  }

  async tabs({ action, tab_id: tabId, url }) {
    await this.session.settlePopups();
    if (action === "list") return { ok: true, tabs: await this.session.listTabs() };

    if (action === "new") {
      const page = await this.session.newTab();
      if (url) {
        const target = this.#approvedUrl(url);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (/^https?:/i.test(page.url())) this.#approvedUrl(page.url());
      }
      return this.snapshot();
    }

    if (!tabId) throw new Error(`browser_tabs action ${action} requires tab_id.`);
    if (action === "switch") await this.session.switchTab(tabId);
    if (action === "close") await this.session.closeTab(tabId);
    return this.snapshot();
  }

  async screenshot({ full_page: fullPage }) {
    await this.session.settlePopups();
    await fs.mkdir(this.config.artifactsDir, { recursive: true });
    const basename = `edge-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    const filename = path.join(this.config.artifactsDir, basename);
    const bytes = await this.session.page().screenshot({ path: filename, fullPage });
    const metadata = {
      ok: true,
      artifact: path.relative(process.cwd(), filename),
      url: sanitizeUrlForModel(this.session.page().url()),
    };

    if (!this.config.inlineScreenshots) return metadata;
    return {
      kind: "image",
      metadata,
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    };
  }

  async runtime(args) {
    if (args.action === "status") {
      return { ...describeRuntime(this.config, this.hooks.env), manualPause: this.manualPause };
    }
    const plan = planRuntimeChange(this.config, args, this.hooks.env, this.hooks.cwd || this.config.workspaceRoot);
    if (!plan.relaunch) {
      Object.assign(this.config, plan.next);
      if (this.session) this.session.bringToFront = this.config.bringToFront !== false;
      if (plan.live && this.session?.applyWindow) {
        await this.session.applyWindow(this.config.windowWidth, this.config.windowHeight);
        if (this.config.bringToFront) await this.session.page?.().bringToFront?.().catch(() => {});
      }
    } else {
      if (!this.hooks.relaunch) throw new Error("This session cannot relaunch the browser.");
      await this.hooks.relaunch(plan.next, this);
      this.manualPause = null;
      if (this.session?.applyWindow) await this.session.applyWindow(this.config.windowWidth, this.config.windowHeight);
    }
    saveRuntimeState(this.config, this.hooks.cwd || this.config.workspaceRoot);
    return {
      ...describeRuntime(this.config, this.hooks.env),
      relaunched: plan.relaunch,
      manualPause: this.manualPause,
    };
  }

  async console({ action, level = "all" }) {
    const log = this.session.inspection;
    if (!log) throw new Error("Console inspection is unavailable.");
    if (action === "clear") {
      log.clearConsole();
      return { ok: true, messages: [] };
    }
    if (action !== "list") throw new Error("browser_console action must be list or clear.");
    return { ok: true, messages: log.listConsole(level) };
  }

  async network({ action, limit = 50 }) {
    const log = this.session.inspection;
    if (!log) throw new Error("Network inspection is unavailable.");
    if (action === "clear") {
      log.clearNetwork();
      return { ok: true, requests: [] };
    }
    if (action !== "list") throw new Error("browser_network action must be list or clear.");
    return { ok: true, requests: log.listNetwork(limit) };
  }

  async styles({ ref }) {
    const locator = await this.assertRefAvailable(ref);
    const details = await locator.evaluate((element) => {
      const keys = [
        "display", "position", "color", "backgroundColor", "fontSize", "fontFamily",
        "fontWeight", "lineHeight", "margin", "padding", "width", "height", "border",
        "opacity", "zIndex", "overflow", "textAlign", "gap",
      ];
      const computed = getComputedStyle(element);
      const style = {};
      for (const key of keys) style[key] = computed[key] || "";
      const id = element.id ? `#${element.id}` : "";
      const classes = [...element.classList].slice(0, 6).map((name) => `.${name}`).join("");
      return {
        node: `${element.tagName.toLowerCase()}${id}${classes}`.slice(0, 200),
        style,
      };
    });
    return { ok: true, ref, ...details };
  }

  async site({ action, origin = "", decision = "keep" }) {
    if (action === "status") return this.sitePolicy.status();
    if (action !== "decide") throw new Error("browser_site action must be status or decide.");
    if (!origin) throw new Error("browser_site decide requires an origin.");
    return this.sitePolicy.decide(origin, decision);
  }

  async dialog({ action, decision = "keep", prompt_text: promptText = "" }) {
    if (action === "status") {
      return { ok: true, armed: this.session.dialogStatus?.() || null, lastDialog: this.session.lastDialog || null };
    }
    if (action !== "arm") throw new Error("browser_dialog action must be status or arm.");
    if (!["accept", "dismiss"].includes(decision)) {
      throw new Error("browser_dialog decision must be accept or dismiss.");
    }
    this.session.armDialog?.({ decision, promptText: String(promptText || "").slice(0, 500) });
    return { ok: true, armed: { decision, promptText: promptText ? "[set]" : "" } };
  }

  async handoff({ action }) {
    if (action === "status") {
      return { ok: true, manualPause: this.manualPause, needsUser: Boolean(this.manualPause) };
    }
    if (action === "pause") {
      await this.session.ensureReady();
      const page = this.session.page();
      await page.bringToFront?.().catch(() => {});
      this.manualPause = { reason: "user", url: sanitizeUrlForModel(page.url()) };
      return { ...(await this.snapshot()), paused: true };
    }
    if (action === "resume") {
      this.manualPause = null;
      return this.snapshot();
    }
    throw new Error("browser_handoff action must be status, pause, or resume.");
  }

  async execute(name, args) {
    if (name === "browser_runtime" && args.action === "status") return this.runtime(args);
    if (name === "browser_handoff" && args.action === "status") return this.handoff(args);
    if (name === "browser_dialog" && args.action === "status") return this.dialog(args);
    if (name === "browser_site") return this.site(args);
    const passive = name === "browser_snapshot"
      || name === "browser_screenshot"
      || name === "browser_handoff"
      || name === "browser_wait"
      || name === "browser_runtime"
      || name === "browser_dialog"
      || name === "browser_console"
      || name === "browser_network"
      || name === "browser_styles"
      || name === "browser_site";
    if (!passive) this.#assertAutomated();
    if (!(name === "browser_tabs" && args.action === "new") && name !== "browser_runtime") {
      await this.session.ensureReady();
    }
    switch (name) {
      case "browser_snapshot": return this.snapshot();
      case "browser_navigate": return this.navigate(args);
      case "browser_click": return this.click(args);
      case "browser_hover": return this.hover(args);
      case "browser_double_click": return this.doubleClick(args);
      case "browser_file": return this.file(args);
      case "browser_dialog": return this.dialog(args);
      case "browser_type": return this.type(args);
      case "browser_press": return this.press(args);
      case "browser_select": return this.select(args);
      case "browser_scroll": return this.scroll(args);
      case "browser_wait": return this.wait(args);
      case "browser_history": return this.history(args);
      case "browser_tabs": return this.tabs(args);
      case "browser_screenshot": return this.screenshot(args);
      case "browser_console": return this.console(args);
      case "browser_network": return this.network(args);
      case "browser_styles": return this.styles(args);
      case "browser_site": return this.site(args);
      case "browser_runtime": return this.runtime(args);
      case "browser_handoff": return this.handoff(args);
      default: throw new Error(`Unknown browser tool: ${name}`);
    }
  }
}
