import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_CODE_VERSION_ENV,
  getClaudeCodeVersion,
  makeClaudeCodeUserAgent,
} from "../.test-dist/version.js";

test("user agent uses the claude-cli form with the default version", () => {
  const version = getClaudeCodeVersion({});
  assert.equal(version, "2.1.280");
  assert.equal(makeClaudeCodeUserAgent({}), `claude-cli/${version} (external, cli)`);
});

test("version override is honoured and trimmed", () => {
  const env = { [CLAUDE_CODE_VERSION_ENV]: " 9.9.9 " };
  assert.equal(getClaudeCodeVersion(env), "9.9.9");
  assert.equal(makeClaudeCodeUserAgent(env), "claude-cli/9.9.9 (external, cli)");
});

test("blank override falls back to the default", () => {
  assert.equal(
    getClaudeCodeVersion({ [CLAUDE_CODE_VERSION_ENV]: "  " }),
    getClaudeCodeVersion({}),
  );
});
