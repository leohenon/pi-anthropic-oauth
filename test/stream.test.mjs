import test from "node:test";
import assert from "node:assert/strict";
import { usesAdaptiveThinking } from "../.test-dist/stream.js";

const gate = (id, compat) => usesAdaptiveThinking({ id, compat });

test("routes current models to adaptive thinking", () => {
  for (const id of [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ]) {
    assert.equal(gate(id), true, `${id} should use adaptive thinking`);
  }
});

test("keeps pre-4.6 models on budget_tokens", () => {
  for (const id of [
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-1",
    "claude-opus-4-0",
    "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20241022",
  ]) {
    assert.equal(gate(id), false, `${id} should use budget_tokens`);
  }
});

test("defaults unknown and future model ids to the path that works", () => {
  // budget_tokens is removed API-wide, so an unrecognized id must not land there.
  for (const id of [
    "claude-opus-6",
    "claude-sonnet-7-2",
    "claude-mythos-preview",
    "my-custom-anthropic-model",
  ]) {
    assert.equal(gate(id), true, `${id} should default to adaptive thinking`);
  }
});

test("normalizes dotted model ids from models.json", () => {
  assert.equal(gate("claude-opus-4.6"), true);
  assert.equal(gate("claude-opus-4.5"), false);
});

test("honors an explicit compat override in both directions", () => {
  assert.equal(gate("claude-opus-4-5", { forceAdaptiveThinking: true }), true);
  assert.equal(gate("claude-opus-5", { forceAdaptiveThinking: false }), false);
});
