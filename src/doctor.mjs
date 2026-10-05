import "dotenv/config";
import { BrowserTools } from "./browser-tools.mjs";
import { assertApiConfig, loadConfig } from "./config.mjs";
import { browserLabel, connectEdge, findBrowserExecutable } from "./edge-session.mjs";
import { checkProviderCompatibility, createOpenAIClient } from "./responses-agent.mjs";

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function info(message) {
  console.log(`[INFO] ${message}`);
}

async function checkLocalBrowser(config) {
  const executable = findBrowserExecutable(config);
  const label = browserLabel(config);
  if (!executable) throw new Error(`${label} executable was not found.`);
  pass(`${label} executable: ${executable}`);

  const session = await connectEdge(config, info);
  pass(`CDP connection: ${config.cdpUrl}`);

  const originalPage = session.page();
  const diagnosticPage = await session.newTab();
  try {
    await diagnosticPage.setContent(`
      <!doctype html>
      <html>
        <head><title>Responses Edge Doctor</title></head>
        <body>
          <label for="name">Diagnostic value</label>
          <input id="name" />
          <button id="run" onclick="document.querySelector('#status').textContent = 'clicked'">Run diagnostic</button>
          <p id="status">ready</p>
        </body>
      </html>
    `);

    const browserTools = new BrowserTools(session, config);
    const initial = await browserTools.snapshot();
    const input = initial.elements.find((element) => element.name === "Diagnostic value");
    const button = initial.elements.find((element) => element.name === "Run diagnostic");
    if (!input || !button) throw new Error("Semantic snapshot did not expose diagnostic controls.");

    const afterType = await browserTools.type({ ref: input.ref, text: "local-ok", submit: false });
    const currentButton = afterType.elements.find((element) => element.name === "Run diagnostic");
    if (!currentButton) throw new Error("Button ref was lost after typing.");
    const afterClick = await browserTools.click({ ref: currentButton.ref });
    if (!afterClick.text.includes("clicked")) throw new Error("Local click did not update the page.");
    pass("Semantic snapshot, type, and click tools");
  } finally {
    await diagnosticPage.close().catch(() => {});
    if (!originalPage.isClosed()) {
      session.currentPage = originalPage;
      await session.maybeBringToFront(originalPage).catch(() => {});
    }
  }

  return session;
}

async function main() {
  const checkApi = process.argv.includes("--api");
  const config = loadConfig();
  info(`Node ${process.version}`);
  info(`Responses mode: ${config.stateMode}; compatibility mode: ${config.compatMode}`);

  const session = await checkLocalBrowser(config);

  if (checkApi) {
    assertApiConfig(config);
    info(`Checking ${config.baseURL} with model ${config.model}`);
    const result = await checkProviderCompatibility(createOpenAIClient(config), config);
    pass(`Responses function-call round trip: ${result.text.trim()}`);
  } else {
    info("API check skipped. Run npm run doctor:api to test provider compatibility.");
  }

  await session.shutdown({ keepOpen: config.keepEdgeOpen });
  process.stdout.write("Doctor completed successfully.\n", () => process.exit(0));
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message}`);
  if (error.status) console.error(`[FAIL] HTTP status: ${error.status}`);
  process.exit(1);
});
