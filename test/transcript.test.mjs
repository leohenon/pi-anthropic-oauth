import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { convertPiMessagesToAnthropic, convertPiToolsToAnthropic } from "../.test-dist/convert.js";
import { buildAnthropicSystemPrompt } from "../.test-dist/prompt.js";

const TOOLS = [
  {
    name: "bash",
    description: "Run a bash command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

function makeTranscript() {
  return normalizeContext({
    systemPrompt: "You are a helpful coding agent.",
    tools: TOOLS,
    messages: [{ role: "user", content: "run echo ok", timestamp: Date.now() }],
  });
}

test("tools are recovered from a normalized TranscriptContext", () => {
  const transcript = collapseSystemMessages(makeTranscript());
  const tools = getCurrentTools(transcript.messages);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.name).sort(), ["bash", "read"]);

  const params = convertPiToolsToAnthropic(tools, true);
  assert.equal(params.length, 2);
  assert.deepEqual(params.map((t) => t.name).sort(), ["Bash", "Read"]);
});

test("system prompt is recovered from a normalized TranscriptContext", () => {
  const transcript = collapseSystemMessages(makeTranscript());
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  assert.match(systemPrompt, /helpful coding agent/);

  const system = buildAnthropicSystemPrompt(systemPrompt, true);
  assert.ok(Array.isArray(system));
  assert.ok(
    system.some((block) => block.type === "text" && /helpful coding agent/.test(block.text)),
  );
});

test("system transcript messages are not forwarded as chat messages", () => {
  const transcript = collapseSystemMessages(makeTranscript());
  assert.ok(transcript.messages.some((m) => m.role === "system"));

  const messages = convertPiMessagesToAnthropic(transcript.messages, true, {
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-test",
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
});
