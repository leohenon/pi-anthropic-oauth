import test from "node:test";
import assert from "node:assert/strict";
import { convertPiMessagesToAnthropic } from "../.test-dist/convert.js";

function assistant(content) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-8",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

test("replays signed thinking blocks unchanged", () => {
  const converted = convertPiMessagesToAnthropic(
    [
      assistant([
        {
          type: "thinking",
          thinking: "summary",
          thinkingSignature: "signed-payload",
        },
      ]),
    ],
    true,
  );

  assert.deepEqual(converted, [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "summary",
          signature: "signed-payload",
        },
      ],
    },
  ]);
});

test("replays redacted thinking as its opaque payload", () => {
  const converted = convertPiMessagesToAnthropic(
    [
      assistant([
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "encrypted-payload",
          redacted: true,
        },
      ]),
    ],
    true,
  );

  assert.deepEqual(converted[0].content, [
    { type: "redacted_thinking", data: "encrypted-payload" },
  ]);
});

test("degrades unsigned partial thinking to assistant text", () => {
  const converted = convertPiMessagesToAnthropic(
    [assistant([{ type: "thinking", thinking: "partial reasoning" }])],
    true,
  );

  assert.deepEqual(converted[0].content, [
    { type: "text", text: "partial reasoning" },
  ]);
});
