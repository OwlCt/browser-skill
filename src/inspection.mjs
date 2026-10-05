const MAX_ENTRIES = 200;
const SENSITIVE_QUERY_KEY = /(access|auth|code|credential|jwt|key|password|secret|session|signature|token)/i;

function sanitizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.href;
  } catch {
    return String(rawUrl || "");
  }
}
const STYLE_PROPERTIES = [
  "display",
  "position",
  "color",
  "backgroundColor",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "lineHeight",
  "margin",
  "padding",
  "width",
  "height",
  "border",
  "opacity",
  "zIndex",
  "overflow",
  "textAlign",
  "gap",
];

function pushBounded(list, entry) {
  list.push(entry);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function createInspectionLog() {
  const consoleEntries = [];
  const network = [];
  const byRequest = new Map();
  let nextId = 1;

  return {
    console(message) {
      let location = {};
      try {
        location = message.location?.() || {};
      } catch {
        location = {};
      }
      pushBounded(consoleEntries, {
        level: String(message.type?.() || "log"),
        text: cleanText(message.text?.() || ""),
        url: sanitizeUrl(location.url || ""),
        line: Number(location.lineNumber) || 0,
      });
    },
    pageError(error) {
      pushBounded(consoleEntries, {
        level: "error",
        text: cleanText(error?.message || error),
        url: "",
        line: 0,
      });
    },
    request(request) {
      const entry = {
        id: nextId,
        method: String(request.method?.() || "GET"),
        url: sanitizeUrl(request.url?.() || ""),
        type: String(request.resourceType?.() || ""),
        status: 0,
        failed: "",
      };
      nextId += 1;
      byRequest.set(request, entry);
      pushBounded(network, entry);
    },
    response(response) {
      const request = response.request?.();
      const entry = byRequest.get(request);
      if (entry) entry.status = Number(response.status?.()) || 0;
    },
    requestFailed(request) {
      const entry = byRequest.get(request);
      if (!entry) return;
      entry.failed = cleanText(request.failure?.()?.errorText || "failed");
    },
    listConsole(level = "all") {
      const selected = level === "all"
        ? consoleEntries
        : consoleEntries.filter((entry) => (
          level === "log" ? !["error", "warning", "info"].includes(entry.level) : entry.level === level
        ));
      return selected.slice(-100);
    },
    clearConsole() {
      consoleEntries.length = 0;
    },
    listNetwork(limit = 50) {
      const bounded = Math.min(100, Math.max(1, Number(limit) || 50));
      return network.slice(-bounded);
    },
    clearNetwork() {
      network.length = 0;
      byRequest.clear();
    },
  };
}

export { STYLE_PROPERTIES };
