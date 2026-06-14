import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_REWRITE_MODE_ENV,
  PI_REWRITE_PATTERN_ENV,
  sanitizeSystemText,
} from "../.test-dist/prompt.js";

function rewriteEnv(mode, pattern) {
  return {
    [PI_REWRITE_MODE_ENV]: mode,
    ...(pattern === undefined ? {} : { [PI_REWRITE_PATTERN_ENV]: pattern }),
  };
}

test("default rewrite mode remains aggressive", () => {
  assert.equal(
    sanitizeSystemText("Work in /srv/dev/pi-foo.\n\nPi can use pi."),
    "Work in /srv/dev/Claude Code-foo.\n\nClaude Code can use Claude Code.",
  );
});

test("path-safe mode preserves pi immediately after slashes", () => {
  assert.equal(
    sanitizeSystemText(
      "Work in /srv/dev/pi-foo and C:\\Users\\pi\\repo.\n\nPi can use pi.",
      rewriteEnv("path-safe"),
    ),
    "Work in /srv/dev/pi-foo and C:\\Users\\pi\\repo.\n\nClaude Code can use Claude Code.",
  );
});

test("technical-safe mode preserves common technical tokens", () => {
  assert.equal(
    sanitizeSystemText(
      "Pi pi /pi .pi pi-foo npm:pi-anthropic-oauth @scope/pi-helper foo_pi pi:bar",
      rewriteEnv("technical-safe"),
    ),
    "Claude Code Claude Code /pi .pi pi-foo npm:pi-anthropic-oauth @scope/pi-helper foo_pi pi:bar",
  );
});

test("custom mode accepts a regex source", () => {
  assert.equal(
    sanitizeSystemText("Pi pi", rewriteEnv("custom", "\\bPi\\b")),
    "Claude Code pi",
  );
});

test("custom mode accepts a regex literal and adds the global flag", () => {
  assert.equal(
    sanitizeSystemText("Pi pi PI", rewriteEnv("custom", "/\\bpi\\b/i")),
    "Claude Code Claude Code Claude Code",
  );
});

test("custom mode can disable rewriting with a never-matching pattern", () => {
  assert.equal(
    sanitizeSystemText("Pi pi", rewriteEnv("custom", "(?!)")),
    "Pi pi",
  );
});

test("invalid rewrite configuration fails clearly", () => {
  assert.throws(
    () => sanitizeSystemText("Pi", rewriteEnv("unknown")),
    /Invalid PI_ANTHROPIC_OAUTH_REWRITE_MODE/,
  );

  assert.throws(
    () => sanitizeSystemText("Pi", rewriteEnv("custom")),
    /PI_ANTHROPIC_OAUTH_REWRITE_PATTERN must be set/,
  );

  assert.throws(
    () => sanitizeSystemText("Pi", rewriteEnv("custom", "(")),
    /Invalid PI_ANTHROPIC_OAUTH_REWRITE_PATTERN/,
  );
});
