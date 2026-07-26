import test from "node:test";
import assert from "node:assert/strict";
import {
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
