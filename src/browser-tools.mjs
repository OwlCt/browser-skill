import fs from "node:fs/promises";
import path from "node:path";

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
    "Wait briefly for a page update and then return the page state.",
    { milliseconds: { type: "integer", minimum: 100, maximum: 10000 } },
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
];

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
  constructor(session, config) {
    this.session = session;
    this.config = config;
    this.definitions = browserToolDefinitions;
  }

  async snapshot() {
    const page = this.session.page();
    await settle(page);

    const state = await page.evaluate(({ maxTextChars, maxElements }) => {
      const REF_ATTRIBUTE = "data-responses-ref";
      document.querySelectorAll(`[${REF_ATTRIBUTE}]`).forEach((element) => {
        element.removeAttribute(REF_ATTRIBUTE);
      });

      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return element.getAttribute("aria-hidden") !== "true"
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      };

      const clean = (value, limit = 160) => String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);

      const accessibleName = (element) => {
        const labelledBy = (element.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ");
        const labels = element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "";
        const type = element.getAttribute("type")?.toLowerCase();
        const safeValue = ["button", "submit", "reset"].includes(type) ? element.value : "";
        return clean(
          element.getAttribute("aria-label")
          || labelledBy
          || labels
          || element.getAttribute("alt")
          || element.getAttribute("title")
          || element.getAttribute("placeholder")
          || element.innerText
          || safeValue
          || element.getAttribute("name"),
        );
      };

      const selector = [
        "a[href]",
        "button",
        "input:not([type='hidden']):not([type='file'])",
        "textarea",
        "select",
        "summary",
        "[contenteditable='true']",
        "[role='button']",
        "[role='link']",
        "[role='checkbox']",
        "[role='radio']",
        "[role='tab']",
        "[role='menuitem']",
      ].join(",");

      const elements = [...document.querySelectorAll(selector)]
        .filter(isVisible)
        .slice(0, maxElements)
        .map((element, index) => {
          const ref = `e${index + 1}`;
          element.setAttribute(REF_ATTRIBUTE, ref);
          const tag = element.tagName.toLowerCase();
          const type = element.getAttribute("type")?.toLowerCase() || "";
          const item = {
            ref,
            tag,
            role: element.getAttribute("role") || "",
            type,
            name: type === "password" ? "[password field]" : accessibleName(element),
            disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          };

          if (type === "checkbox" || type === "radio") item.checked = Boolean(element.checked);
          if (tag === "select") {
            item.value = element.value;
            item.options = [...element.options].slice(0, 50).map((option) => ({
              value: option.value,
              label: clean(option.label, 100),
              selected: option.selected,
            }));
          }
          return item;
        });

      const bodyText = (document.body?.innerText || "")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return {
        title: document.title,
        text: bodyText.slice(0, maxTextChars),
        textTruncated: bodyText.length > maxTextChars,
        elements,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollY: Math.round(window.scrollY),
          pageHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight),
        },
      };
    }, { maxTextChars: this.config.maxTextChars, maxElements: 200 });

    return {
      ok: true,
      tabId: this.session.tabId(page),
      url: sanitizeUrlForModel(page.url()),
      ...state,
    };
  }

  locatorForRef(ref) {
    if (!/^e\d+$/.test(ref)) throw new Error(`Invalid element ref: ${ref}`);
    const locator = this.session.page().locator(`[data-responses-ref="${ref}"]`);
    return locator;
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
    const target = assertNavigableUrl(url, this.config.allowedOrigins);
    const page = this.session.page();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.afterAction();
  }

  async click({ ref }) {
    const locator = await this.assertRefAvailable(ref);
    await locator.click({ timeout: 15_000 });
    return this.afterAction();
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

  async wait({ milliseconds }) {
    const bounded = Math.min(10_000, Math.max(100, Number(milliseconds)));
    await this.session.page().waitForTimeout(bounded);
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
        const target = assertNavigableUrl(url, this.config.allowedOrigins);
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
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

  async execute(name, args) {
    if (!(name === "browser_tabs" && args.action === "new")) {
      await this.session.ensureReady();
    }
    switch (name) {
      case "browser_snapshot": return this.snapshot();
      case "browser_navigate": return this.navigate(args);
      case "browser_click": return this.click(args);
      case "browser_type": return this.type(args);
      case "browser_press": return this.press(args);
      case "browser_select": return this.select(args);
      case "browser_scroll": return this.scroll(args);
      case "browser_wait": return this.wait(args);
      case "browser_history": return this.history(args);
      case "browser_tabs": return this.tabs(args);
      case "browser_screenshot": return this.screenshot(args);
      default: throw new Error(`Unknown browser tool: ${name}`);
    }
  }
}
