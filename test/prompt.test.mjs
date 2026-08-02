import test from "node:test";
import assert from "node:assert/strict";
import {
  PI_REWRITE_MODE_ENV,
  PI_REWRITE_PATTERN_ENV,
  sanitizeSurrogates,
  sanitizeSystemText,
} from "../.test-dist/prompt.js";

test("preserves valid surrogate pairs (non-BMP characters)", () => {
  assert.equal(sanitizeSurrogates("\u{1F680}"), "\u{1F680}");
  assert.equal(sanitizeSurrogates("a\u{1F355}b\u{1F408}c"), "a\u{1F355}b\u{1F408}c");
});

test("leaves BMP text untouched", () => {
  assert.equal(sanitizeSurrogates("\u2615\uFE0F \u26A0 \u2192"), "\u2615\uFE0F \u26A0 \u2192");
});

test("replaces unpaired surrogates", () => {
  assert.equal(sanitizeSurrogates("\uD800"), "\uFFFD");
  assert.equal(sanitizeSurrogates("\uDC00"), "\uFFFD");
  assert.equal(sanitizeSurrogates("\uDC00\uD800"), "\uFFFD\uFFFD"); // reversed pair
});

test("replaces unpaired surrogates adjacent to valid pairs", () => {
  assert.equal(sanitizeSurrogates("\u{1F680}\uD800"), "\u{1F680}\uFFFD");
  assert.equal(sanitizeSurrogates("\uD800\u{1F680}"), "\uFFFD\u{1F680}");
  assert.equal(sanitizeSurrogates("\u{1F680}\uDC00"), "\u{1F680}\uFFFD");
  assert.equal(sanitizeSurrogates("\uD800\uD800\uDC00"), "\uFFFD\u{10000}");
});

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
