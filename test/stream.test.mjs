import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  applyMessageDelta,
  streamAnthropicOAuth,
  usesAdaptiveThinking,
} from "../.test-dist/stream.js";

const model = {
  id: "claude-test",
  name: "Claude Test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
  },
  contextWindow: 200000,
  maxTokens: 8192,
};

function message() {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 100,
      output: 0,
      cacheRead: 80,
      cacheWrite: 20,
      totalTokens: 200,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

test("null message-delta fields preserve start usage and stop reason", () => {
  const output = message();

  applyMessageDelta(output, model, null, {
    input_tokens: null,
    output_tokens: 12,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  });

  assert.equal(output.stopReason, "stop");
  assert.deepEqual(
    {
      input: output.usage.input,
      output: output.usage.output,
      cacheRead: output.usage.cacheRead,
      cacheWrite: output.usage.cacheWrite,
      totalTokens: output.usage.totalTokens,
    },
    { input: 100, output: 12, cacheRead: 80, cacheWrite: 20, totalTokens: 212 },
  );
});

test("routes only known legacy models to budget-based thinking", () => {
  for (const id of [
    "claude-opus-4-5",
    "claude-sonnet-4-0",
    "claude-3-5-sonnet-20241022",
  ]) {
    assert.equal(usesAdaptiveThinking({ id }), false, id);
  }

  for (const id of [
    "claude-opus-4-6",
    "claude-opus-5",
    "claude-future-preview",
    "custom-anthropic-model",
  ]) {
    assert.equal(usesAdaptiveThinking({ id }), true, id);
  }

  assert.equal(
    usesAdaptiveThinking({
      id: "claude-opus-4-5",
      compat: { forceAdaptiveThinking: true },
    }),
    true,
  );
  assert.equal(
    usesAdaptiveThinking({
      id: "claude-opus-5",
      compat: { forceAdaptiveThinking: false },
    }),
    false,
  );
});

test("message deltas accept explicit zeroes and terminal stop reasons", () => {
  const output = message();

  applyMessageDelta(output, model, "max_tokens", {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 },
  });

  assert.equal(output.stopReason, "length");
  assert.equal(output.usage.input, 0);
  assert.equal(output.usage.output, 0);
  assert.equal(output.usage.cacheRead, 0);
  assert.equal(output.usage.cacheWrite, 0);
  assert.equal(output.usage.reasoning, 0);
  assert.equal(output.usage.totalTokens, 0);
});

test("unknown stop reasons mark the message as an error", () => {
  const output = message();
  applyMessageDelta(output, model, "future_reason", undefined);
  assert.equal(output.stopReason, "error");
  assert.equal(output.errorMessage, "Provider stop reason: future_reason");
});

test("refusal stop reasons surface the provider explanation", () => {
  const output = message();
  applyMessageDelta(output, model, "refusal", undefined, {
    explanation: "Blocked for policy reasons.",
  });
  assert.equal(output.stopReason, "error");
  assert.equal(
    output.errorMessage,
    "Provider stop reason: refusal — Blocked for policy reasons.",
  );
});

// Simulate a body iterator throwing after its last chunk (#37).
async function streamWithBodyFailure({
  complete = true,
  fail = true,
  stopReason = "end_turn",
  abort = false,
} = {}) {
  const controller = new AbortController();
  const events = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: 4 },
    },
  ];
  if (complete) events.push({ type: "message_stop" });

  const response = new Response(null, {
    headers: { "content-type": "text/event-stream" },
  });
  Object.defineProperty(response, "body", {
    value: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(events.map((event) =>
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ).join(""));
        if (abort) controller.abort();
        if (fail) throw new TypeError("undefined is not a function");
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    const stream = streamAnthropicOAuth(model, normalizeContext({
      messages: [{ role: "user", content: "say ok", timestamp: 0 }],
    }), { apiKey: "test-key", signal: controller.signal });
    const received = [];
    for await (const event of stream) received.push(event);
    return received;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a normally closed complete response succeeds", async () => {
  const events = await streamWithBodyFailure({ fail: false });
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).message.content[0].text, "ok");
});

for (const [stopReason, reason] of [
  ["end_turn", "stop"],
  ["max_tokens", "length"],
  ["tool_use", "toolUse"],
]) {
  test(`body errors after message_stop preserve ${reason} completion`, async () => {
    const events = await streamWithBodyFailure({ stopReason });
    const last = events.at(-1);
    assert.equal(last.type, "done");
    assert.equal(last.reason, reason);
    assert.equal(last.message.content[0].text, "ok");
    assert.equal(last.message.usage.input, 100);
    assert.equal(last.message.usage.output, 4);
    assert.equal(last.message.usage.totalTokens, 104);
    assert.equal(events.filter((event) => event.type === "done").length, 1);
    assert.equal(events.some((event) => event.type === "error"), false);
  });
}

test("body errors before message_stop still fail even after message_delta", async () => {
  const events = await streamWithBodyFailure({ complete: false });
  const last = events.at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.reason, "error");
  assert.equal(last.error.errorMessage, "undefined is not a function");
  assert.equal(events.some((event) => event.type === "done"), false);
});

test("abort after message_stop is not swallowed with the body error", async () => {
  const events = await streamWithBodyFailure({ abort: true });
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).reason, "aborted");
});

test("unknown stop reasons still fail after message_stop and a body error", async () => {
  const events = await streamWithBodyFailure({ stopReason: "future_reason" });
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).reason, "error");
  assert.equal(events.at(-1).error.errorMessage, "Provider stop reason: future_reason");
});
