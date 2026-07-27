import test from "node:test";
import assert from "node:assert/strict";
import { convertPiMessagesToAnthropic } from "../.test-dist/convert.js";

const activeModel = {
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-opus-5",
};

function assistant(content, overrides = {}) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

test("replays signed thinking for the active provider, API, and model", () => {
  const converted = convertPiMessagesToAnthropic(
    [
      assistant([
        {
          type: "thinking",
          thinking: "private reasoning",
          thinkingSignature: "signed-envelope",
        },
        { type: "text", text: "Visible answer" },
      ]),
    ],
    true,
    activeModel,
  );

  assert.deepEqual(converted[0].content, [
    {
      type: "thinking",
      thinking: "private reasoning",
      signature: "signed-envelope",
    },
    { type: "text", text: "Visible answer" },
  ]);
});

test("does not replay thinking signatures across model identities", () => {
  for (const overrides of [
    { provider: "other" },
    { api: "other-api" },
    { model: "claude-fable-5" },
  ]) {
    const converted = convertPiMessagesToAnthropic(
      [
        assistant(
          [
            {
              type: "thinking",
              thinking: "portable context",
              thinkingSignature: "model-bound-signature",
            },
          ],
          overrides,
        ),
      ],
      true,
      activeModel,
    );

    assert.deepEqual(converted[0].content, [
      { type: "text", text: "portable context" },
    ]);
  }
});

test("replays redacted thinking only for the active model", () => {
  const block = {
    type: "thinking",
    thinking: "[Reasoning redacted]",
    thinkingSignature: "opaque-redacted-data",
    redacted: true,
  };

  const matching = convertPiMessagesToAnthropic(
    [assistant([block, { type: "text", text: "answer" }])],
    true,
    activeModel,
  );
  assert.deepEqual(matching[0].content, [
    { type: "redacted_thinking", data: "opaque-redacted-data" },
    { type: "text", text: "answer" },
  ]);

  const differentModel = convertPiMessagesToAnthropic(
    [assistant([block, { type: "text", text: "answer" }], { model: "claude-fable-5" })],
    true,
    activeModel,
  );
  assert.deepEqual(differentModel[0].content, [
    { type: "text", text: "answer" },
  ]);
});

test("converts unsigned thinking to text and preserves tool-use ordering", () => {
  const converted = convertPiMessagesToAnthropic(
    [
      assistant([
        { type: "thinking", thinking: "unsigned reasoning" },
        { type: "thinking", thinking: "" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: 0,
      },
    ],
    true,
    activeModel,
  );

  assert.deepEqual(converted[0].content, [
    { type: "text", text: "unsigned reasoning" },
    {
      type: "tool_use",
      id: "tool-1",
      name: "Read",
      input: { path: "README.md" },
    },
  ]);
});
