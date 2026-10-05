import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { loadConfig } from "./config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function browserEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => (
    value != null && (/^(EDGE_|BROWSER_)/.test(key) || key === "ALLOW_REMOTE_CDP")
  )));
}

export function loadMcpConfig(env = process.env, root = projectRoot) {
  const envPath = path.join(root, ".env.mcp");
  const defaults = fs.existsSync(envPath) ? parse(fs.readFileSync(envPath)) : {};
  // The stdio server has no provider client. Do not load API credentials from .env.
  // Explicit MCP-client settings must win over the project's default settings.
  return loadConfig({
    LOCALAPPDATA: env.LOCALAPPDATA,
    ...browserEnvironment(defaults),
    ...browserEnvironment(env),
  }, root);
}
