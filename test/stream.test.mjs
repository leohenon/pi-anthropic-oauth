import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageDelta,
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
});
