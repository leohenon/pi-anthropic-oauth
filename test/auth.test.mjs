import test from "node:test";
import assert from "node:assert/strict";
import {
  USER_AGENT,
  buildClaudeCodeUserAgent,
  parseClaudeCodeVersion,
} from "../.test-dist/auth.js";

test("parses Claude Code version output", () => {
  assert.equal(parseClaudeCodeVersion("2.1.214 (Claude Code)"), "2.1.214");
  assert.equal(parseClaudeCodeVersion("claude version unknown"), undefined);
});

test("builds the inference User-Agent used by Claude Code", () => {
  assert.equal(
    buildClaudeCodeUserAgent("2.1.214"),
    "claude-cli/2.1.214 (external, cli)",
  );
  assert.match(USER_AGENT, /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
});
