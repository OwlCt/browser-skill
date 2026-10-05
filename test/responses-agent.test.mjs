import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResponseRequest,
  checkProviderCompatibility,
  responseAgentInternals,
  runResponsesAgent,
} from "../src/responses-agent.mjs";

const baseConfig = {
  model: "test-model",
  stateMode: "manual",
  compatMode: "standard",
  storeResponses: false,
  maxToolSteps: 5,
};

test("manual state mode returns tool output with prior response items", async () => {
  const requests = [];
  const client = {
    responses: {
      async create(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            id: "resp_1",
            output: [{
              type: "function_call",
              call_id: "call_1",
              name: "browser_snapshot",
              arguments: "{}",
            }],
          };
        }
        return {
          id: "resp_2",
          output_text: "done",
          output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
        };
      },
    },
  };
  const browserTools = {
    definitions: [{ type: "function", name: "browser_snapshot", strict: true, parameters: {} }],
    async execute() {
      return { ok: true, title: "Example" };
    },
  };

  const result = await runResponsesAgent({
    client,
    config: baseConfig,
    browserTools,
    task: "inspect the page",
    instructions: "use tools",
  });

  assert.equal(result.text, "done");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].parallel_tool_calls, false);
  assert.equal(requests[1].previous_response_id, undefined);
  assert.ok(requests[1].input.some((item) => item.type === "function_call"));
  const output = requests[1].input.find((item) => item.type === "function_call_output");
  assert.equal(output.call_id, "call_1");
  assert.match(output.output, /Example/);
});

test("minimal compatibility mode removes optional request fields and strict", () => {
  const request = buildResponseRequest(
    { ...baseConfig, compatMode: "minimal" },
    {
      input: "hello",
      instructions: "test",
      tools: [{ type: "function", name: "ping", strict: true, parameters: {} }],
    },
  );

  assert.equal(request.store, undefined);
  assert.equal(request.parallel_tool_calls, undefined);
  assert.equal(request.tools[0].strict, undefined);
});

test("image tool outputs use Responses multimodal function output", () => {
  const output = responseAgentInternals.toolOutput("call_image", {
    kind: "image",
    metadata: { ok: true },
    dataUrl: "data:image/png;base64,AA==",
  });

  assert.equal(output.type, "function_call_output");
  assert.equal(output.output[1].type, "input_image");
});

test("provider doctor validates the full function-call round trip", async () => {
  let turn = 0;
  const client = {
    responses: {
      async create() {
        turn += 1;
        if (turn === 1) {
          return {
            id: "resp_ping",
            output: [{
              type: "function_call",
              call_id: "ping_1",
              name: "compatibility_ping",
              arguments: JSON.stringify({ token: "RESPONSES_OK" }),
            }],
          };
        }
        return {
          id: "resp_final",
          output_text: "COMPATIBLE",
          output: [{ type: "message", content: [{ type: "output_text", text: "COMPATIBLE" }] }],
        };
      },
    },
  };

  const result = await checkProviderCompatibility(client, baseConfig);
  assert.equal(result.text, "COMPATIBLE");
  assert.equal(turn, 2);
});

test("provider doctor retries without forced tool choice after a compatibility error", async () => {
  const requests = [];
  const client = {
    responses: {
      async create(request) {
        requests.push(request);
        if (requests.length === 1) {
          const error = new Error("tool_choice is unsupported");
          error.status = 400;
          throw error;
        }
        if (requests.length === 2) {
          return {
            id: "resp_retry",
            output: [{
              type: "function_call",
              call_id: "ping_retry",
              name: "compatibility_ping",
              arguments: JSON.stringify({ token: "RESPONSES_OK" }),
            }],
          };
        }
        return {
          id: "resp_retry_final",
          output_text: "COMPATIBLE",
          output: [{ type: "message", content: [{ type: "output_text", text: "COMPATIBLE" }] }],
        };
      },
    },
  };

  const result = await checkProviderCompatibility(client, baseConfig);
  assert.equal(result.text, "COMPATIBLE");
  assert.ok(requests[0].tool_choice);
  assert.equal(requests[1].tool_choice, undefined);
  assert.equal(requests.length, 3);
});
