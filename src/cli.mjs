import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { applySavedRuntime, relaunchManagedBrowser } from "./browser-runtime.mjs";
import { BrowserTools } from "./browser-tools.mjs";
import { assertApiConfig, loadConfig } from "./config.mjs";
import { connectEdge } from "./edge-session.mjs";
import { createOpenAIClient, runResponsesAgent } from "./responses-agent.mjs";

function usage() {
  return `Usage:
  npm start -- "Open https://example.com and summarize it"
  Get-Content task.txt | npm start

Configuration is read from .env. Run npm run doctor:api before using a new provider.`;
}

async function readTask() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return "";
  }
  if (args.length > 0) return args.join(" ").trim();
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8").trim();

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question("Browser task: ")).trim();
  } finally {
    terminal.close();
  }
}

async function main() {
  const task = await readTask();
  if (!task) return;

  const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
  const config = applySavedRuntime(loadConfig(), process.env, workspaceRoot);
  assertApiConfig(config);
  const logger = (message) => console.error(`[edge-agent] ${message}`);
  const session = await connectEdge(config, logger);
  const browserTools = new BrowserTools(session, config, {
    env: process.env,
    cwd: workspaceRoot,
    relaunch: (nextConfig, tools) => relaunchManagedBrowser({
      config,
      nextConfig,
      tools,
      logger,
    }),
  });
  const client = createOpenAIClient(config);
  const promptPath = fileURLToPath(new URL("../prompts/browser-agent.md", import.meta.url));
  const instructions = fs.readFileSync(promptPath, "utf8");

  logger(`Connected to ${config.cdpUrl}`);
  logger(`Responses endpoint ${config.baseURL}; model ${config.model}; state ${config.stateMode}`);

  try {
    const result = await runResponsesAgent({
      client,
      config,
      browserTools,
      task,
      instructions,
      logger,
    });
    await browserTools.session.shutdown({ keepOpen: config.keepEdgeOpen });
    process.stdout.write(`${result.text}\n`, () => process.exit(0));
  } catch (error) {
    await browserTools.session.shutdown({ keepOpen: config.keepEdgeOpen }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(`[edge-agent] ${error.message}`);
  if (error.status) console.error(`[edge-agent] HTTP status: ${error.status}`);
  process.exit(1);
});

