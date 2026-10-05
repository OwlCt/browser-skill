import { loadMcpConfig } from "../src/mcp-config.mjs";
import { forceCloseEdge, isCdpReady } from "../src/edge-session.mjs";

const config = {
  ...loadMcpConfig(),
  autoLaunchEdge: false,
  keepEdgeOpen: false,
};

if (!(await isCdpReady(config.cdpUrl))) {
  console.log(`No MCP Edge browser is listening at ${config.cdpUrl}.`);
  process.exit(0);
}

await forceCloseEdge(config);
const deadline = Date.now() + 5_000;
while (Date.now() < deadline && await isCdpReady(config.cdpUrl, 250)) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (await isCdpReady(config.cdpUrl, 250)) {
  throw new Error(`MCP Edge did not close at ${config.cdpUrl}.`);
}
console.log(`Closed MCP Edge browser using profile ${config.edgeUserDataDir}.`);
