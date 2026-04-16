import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "./auth.js";
import { streamAnthropicOAuth } from "./stream.js";

const MODELS = [
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  }
];

function ensureClaudeCodeSymlink() {
  const target = join(homedir(), ".pi");
  const link = join(homedir(), ".Claude Code");
  if (existsSync(target) && !existsSync(link)) {
    try {
      symlinkSync(target, link);
    } catch { }
  }
}

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();
  pi.registerProvider("anthropic", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "ANTHROPIC_MAX_API_KEY",
    api: "anthropic-max-api",
    models: [...MODELS],
    oauth: {
      name: "Claude Pro/Max",
      usesCallbackServer: true,
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    } as unknown as ProviderConfig["oauth"],
    streamSimple: streamAnthropicOAuth,
  });
}
