import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_OAUTH_BETAS,
  buildThinkingRequest,
  createClaudeCodeSessionId,
} from "../.test-dist/request.js";

function model(overrides = {}) {
  return {
    id: "claude-opus-4-5",
    name: "Claude",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    ...overrides,
  };
}

test("OAuth requests include the current Claude Code baseline betas", () => {
  assert.deepEqual(REQUIRED_OAUTH_BETAS, [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
  ]);
});

test("adaptive models use effort instead of budget_tokens", () => {
  assert.deepEqual(
    buildThinkingRequest(
      model({
        id: "claude-opus-4-8",
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap: { xhigh: "xhigh" },
      }),
      { reasoning: "xhigh" },
      32_000,
    ),
    {
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: "xhigh" },
    },
  );
});

test("legacy models retain bounded token-budget thinking", () => {
  assert.deepEqual(
    buildThinkingRequest(
      model(),
      { reasoning: "high", thinkingBudgets: { high: 50_000 } },
      10_000,
    ),
    {
      thinking: {
        type: "enabled",
        budget_tokens: 9_999,
        display: "summarized",
      },
    },
  );
});

test("session IDs are stable for a persisted Pi conversation", () => {
  const first = {
    systemPrompt: "system",
    messages: [{ role: "user", content: "hello", timestamp: 1234 }],
  };
  const resumed = {
    systemPrompt: "changed",
    messages: [
      { role: "user", content: "hello", timestamp: 1234 },
      { role: "user", content: "again", timestamp: 5678 },
    ],
  };

  const sessionId = createClaudeCodeSessionId(first);
  assert.equal(sessionId, createClaudeCodeSessionId(resumed));
  assert.match(
    sessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
