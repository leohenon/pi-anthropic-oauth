import test from "node:test";
import assert from "node:assert/strict";
import {
  convertPiMessagesToAnthropic,
  fromClaudeCodeToolName,
  toClaudeCodeToolName,
} from "../.test-dist/convert.js";

test("maps Claude Code tool names case-insensitively", () => {
  assert.equal(toClaudeCodeToolName("read"), "Read");
  assert.equal(toClaudeCodeToolName("bash"), "Bash");
  assert.equal(toClaudeCodeToolName("websearch"), "WebSearch");
});

test("namespaces unknown tool names under mcp__pi__", () => {
  assert.equal(toClaudeCodeToolName("web_search"), "mcp__pi__web_search");
  assert.equal(toClaudeCodeToolName("mcp"), "mcp__pi__mcp");
  assert.equal(toClaudeCodeToolName("enter_plan_mode"), "mcp__pi__enter_plan_mode");
});

test("sanitizes invalid characters in namespaced tool names", () => {
  assert.equal(toClaudeCodeToolName("my.tool:v2"), "mcp__pi__my_tool_v2");
});

test("maps Claude Code tool names back to pi tool names", () => {
  const tools = [{ name: "read" }, { name: "bash" }];
  assert.equal(fromClaudeCodeToolName("Read", tools), "read");
  assert.equal(fromClaudeCodeToolName("Bash", tools), "bash");
});

test("maps namespaced tool names back to pi tool names", () => {
  const tools = [{ name: "web_search" }, { name: "my.tool:v2" }];
  assert.equal(fromClaudeCodeToolName("mcp__pi__web_search", tools), "web_search");
  assert.equal(fromClaudeCodeToolName("mcp__pi__my_tool_v2", tools), "my.tool:v2");
});

test("strips the namespace when the tool list is unavailable", () => {
  assert.equal(fromClaudeCodeToolName("mcp__pi__web_search"), "web_search");
});

test("round-trips every tool name shape", () => {
  for (const name of ["read", "web_search", "enter_plan_mode", "my.tool:v2"]) {
    const tools = [{ name }];
    assert.equal(fromClaudeCodeToolName(toClaudeCodeToolName(name), tools), name);
  }
});

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

test("puts a cache breakpoint on a plain-text user turn", () => {
  const converted = convertPiMessagesToAnthropic(
    [{ role: "user", content: "Explain this repo", timestamp: 0 }],
    true,
    activeModel,
  );

  assert.deepEqual(converted, [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Explain this repo",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
});

test("puts the cache breakpoint only on the history tail", () => {
  const converted = convertPiMessagesToAnthropic(
    [
      { role: "user", content: "first question", timestamp: 0 },
      assistant([{ type: "text", text: "first answer" }]),
      {
        role: "user",
        content: [
          { type: "text", text: "second" },
          { type: "text", text: "question" },
        ],
        timestamp: 0,
      },
    ],
    true,
    activeModel,
  );

  assert.equal(converted[0].content, "first question");
  assert.deepEqual(converted[2].content, [
    { type: "text", text: "second" },
    {
      type: "text",
      text: "question",
      cache_control: { type: "ephemeral" },
    },
  ]);
});

test("puts a cache breakpoint on the last tool result", () => {
  const converted = convertPiMessagesToAnthropic(
    [
      assistant([
        { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
        { type: "toolCall", id: "tool-2", name: "read", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "one" }],
        isError: false,
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "tool-2",
        toolName: "read",
        content: [{ type: "text", text: "two" }],
        isError: false,
        timestamp: 0,
      },
    ],
    true,
    activeModel,
  );

  assert.equal(converted[1].content[0].cache_control, undefined);
  assert.deepEqual(converted[1].content[1].cache_control, {
    type: "ephemeral",
  });
});

test("synthesizes results for trailing unresolved tool calls", () => {
  const converted = convertPiMessagesToAnthropic(
    [
      { role: "user", content: "do it", timestamp: 0 },
      assistant([
        { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
      ]),
    ],
    true,
    activeModel,
  );

  assert.deepEqual(converted.at(-1), {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "No result provided",
        is_error: true,
        cache_control: { type: "ephemeral" },
      },
    ],
  });
});

test("sanitizes surrogates when promoting a user string", () => {
  const converted = convertPiMessagesToAnthropic(
    [{ role: "user", content: "lone \uD800 half", timestamp: 0 }],
    true,
    activeModel,
  );

  assert.equal(converted[0].content[0].text, "lone � half");
});
