import fs from "node:fs";
import path from "node:path";
import { isLoopbackHost } from "./edge-session.mjs";

function policyPath(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), ".runtime", "site-policy.json");
}

function readPolicy(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.v !== 1) return { allow: [], block: [] };
    return {
      allow: Array.isArray(parsed.allow) ? parsed.allow.filter((item) => typeof item === "string") : [],
      block: Array.isArray(parsed.block) ? parsed.block.filter((item) => typeof item === "string") : [],
    };
  } catch {
    return { allow: [], block: [] };
  }
}

export function normalizeSiteOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Site origin must be an HTTP(S) origin.");
  }
  return url.origin;
}

export function createSitePolicy(config = {}) {
  const file = policyPath(config.workspaceRoot || process.cwd());
  const saved = readPolicy(file);
  const once = new Set();

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ v: 1, allow: saved.allow, block: saved.block }, null, 2)}\n`);
  }

  return {
    check(rawUrl, assertNavigableUrl) {
      const href = assertNavigableUrl(rawUrl, config.allowedOrigins || new Set());
      const origin = new URL(href).origin;
      if ((config.sitePolicy || "ask") === "allow") return href;
      if ((config.allowedOrigins || new Set()).has(origin)) return href;
      if (saved.block.includes(origin)) {
        throw new Error(`Origin ${origin} is blocked. Call browser_site with decision allow to change it.`);
      }
      if (isLoopbackHost(new URL(origin).hostname) || saved.allow.includes(origin) || once.has(origin)) return href;
      throw new Error(`Site approval required for ${origin}. Ask the user, then call browser_site with decision allow_once, allow, or block.`);
    },
    decide(originValue, decision) {
      const origin = normalizeSiteOrigin(originValue);
      if (!["allow_once", "allow", "block"].includes(decision)) {
        throw new Error("browser_site decision must be allow_once, allow, or block.");
      }
      saved.allow = saved.allow.filter((item) => item !== origin);
      saved.block = saved.block.filter((item) => item !== origin);
      once.delete(origin);
      if (decision === "allow_once") once.add(origin);
      if (decision === "allow") saved.allow.push(origin);
      if (decision === "block") saved.block.push(origin);
      if (decision !== "allow_once") persist();
      return this.status();
    },
    status() {
      return {
        ok: true,
        mode: config.sitePolicy || "ask",
        allow: [...saved.allow],
        block: [...saved.block],
        once: [...once],
      };
    },
  };
}
