import OpenAI from "openai";

export function createOpenAIClient(config) {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.requestTimeoutMs,
    maxRetries: 2,
  });
}

function toolsForMode(tools, compatMode) {
  if (compatMode !== "minimal") return tools;
  return tools.map(({ strict, ...tool }) => tool);
}

export function buildResponseRequest(config, { input, instructions, tools, previousResponseId }) {
  const request = {
    model: config.model,
    input,
    instructions,
    tools: toolsForMode(tools, config.compatMode),
  };

  if (config.compatMode === "standard") {
    request.parallel_tool_calls = false;
    request.store = config.storeResponses;
  }
  if (previousResponseId) request.previous_response_id = previousResponseId;
  return request;
}

function parseToolArguments(call) {
  if (call.arguments && typeof call.arguments === "object") return call.arguments;
  try {
    return JSON.parse(call.arguments || "{}");
  } catch (error) {
    throw new Error(`Tool ${call.name} returned invalid JSON arguments: ${error.message}`);
  }
}

function outputText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text" || content.type === "text")
    .map((content) => content.text || "")
    .join("\n")
    .trim();
}

function logArgs(name, args) {
  if (name === "browser_type") {
    return JSON.stringify({ ref: args.ref, text: `[redacted ${String(args.text || "").length} chars]`, submit: args.submit });
  }
  return JSON.stringify(args);
}

function toolOutput(callId, result) {
  if (result?.kind === "image") {
    return {
      type: "function_call_output",
      call_id: callId,
      output: [
        { type: "input_text", text: JSON.stringify(result.metadata) },
        { type: "input_image", image_url: result.dataUrl },
      ],
    };
  }

  return {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify(result),
  };
}

async function executeCalls(calls, browserTools, logger) {
  const outputs = [];
  for (const call of calls) {
    if (!call.call_id || !call.name) {
      throw new Error("Provider returned a function_call without call_id or name.");
    }
    let args = {};
    try {
      args = parseToolArguments(call);
      logger(`Tool ${call.name} ${logArgs(call.name, args)}`);
      const result = await browserTools.execute(call.name, args);
      outputs.push(toolOutput(call.call_id, result));
    } catch (error) {
      logger(`Tool ${call.name} failed: ${error.message}`);
      outputs.push(toolOutput(call.call_id, {
        ok: false,
        error: error.message,
        recoverable: true,
      }));
    }
  }
  return outputs;
}

export async function runResponsesAgent({
  client,
  config,
  browserTools,
  task,
  instructions,
  logger = () => {},
}) {
  const initialInput = [{ role: "user", content: task }];
  const conversation = [...initialInput];
  let nextInput = initialInput;
  let previousResponseId;

  for (let step = 1; step <= config.maxToolSteps; step += 1) {
    logger(`Responses turn ${step}/${config.maxToolSteps}`);
    const request = buildResponseRequest(config, {
      input: nextInput,
      instructions,
      tools: browserTools.definitions,
      previousResponseId,
    });
    const response = await client.responses.create(request);
    if (!Array.isArray(response.output)) {
      throw new Error("Provider response is missing the Responses output array.");
    }

    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length === 0) {
      const text = outputText(response);
      if (!text) throw new Error("Provider returned neither function calls nor output text.");
      return { text, response, steps: step };
    }

    const outputs = await executeCalls(calls, browserTools, logger);
    if (config.stateMode === "previous") {
      if (!response.id) throw new Error("Provider did not return an id required by previous state mode.");
      previousResponseId = response.id;
      nextInput = outputs;
    } else {
      conversation.push(...response.output, ...outputs);
      nextInput = conversation;
    }
  }

  throw new Error(`Browser agent exceeded BROWSER_MAX_STEPS=${config.maxToolSteps}.`);
}

const compatibilityTool = {
  type: "function",
  name: "compatibility_ping",
  description: "Return a compatibility token to verify Responses function calling.",
  strict: true,
  parameters: {
    type: "object",
    properties: { token: { type: "string" } },
    required: ["token"],
    additionalProperties: false,
  },
};

export async function checkProviderCompatibility(client, config) {
  const prompt = "Call compatibility_ping exactly once with token RESPONSES_OK. After its output, answer COMPATIBLE.";
  const initialInput = [{ role: "user", content: prompt }];
  const firstRequest = buildResponseRequest(config, {
    input: initialInput,
    instructions: "Follow the user's compatibility test exactly.",
    tools: [compatibilityTool],
  });
  firstRequest.tool_choice = { type: "function", name: "compatibility_ping" };

  let first;
  try {
    first = await client.responses.create(firstRequest);
  } catch (error) {
    if (![400, 404, 422].includes(error.status)) throw error;
    const retryRequest = { ...firstRequest };
    delete retryRequest.tool_choice;
    first = await client.responses.create(retryRequest);
  }
  const call = first.output?.find((item) => item.type === "function_call");
  if (!call) {
    throw new Error("Provider accepted the request but did not return a function_call item.");
  }
  if (!call.call_id) throw new Error("Provider function_call is missing call_id.");
  const args = parseToolArguments(call);
  if (args.token !== "RESPONSES_OK") {
    throw new Error(`Provider returned an unexpected tool argument: ${JSON.stringify(args)}`);
  }

  const result = {
    type: "function_call_output",
    call_id: call.call_id,
    output: JSON.stringify({ token: "RESPONSES_OK", status: "pong" }),
  };
  if (config.stateMode === "previous" && !first.id) {
    throw new Error("Provider did not return an id required by previous state mode.");
  }
  const secondInput = config.stateMode === "previous"
    ? [result]
    : [...initialInput, ...(first.output || []), result];
  const secondRequest = buildResponseRequest(config, {
    input: secondInput,
    instructions: "After receiving compatibility_ping output, answer exactly COMPATIBLE.",
    tools: [compatibilityTool],
    previousResponseId: config.stateMode === "previous" ? first.id : undefined,
  });

  const second = await client.responses.create(secondRequest);
  const text = outputText(second);
  if (!text) {
    throw new Error("Provider accepted function_call_output but did not return final output text.");
  }
  return { first, second, text };
}

export const responseAgentInternals = {
  outputText,
  parseToolArguments,
  toolOutput,
  toolsForMode,
};
