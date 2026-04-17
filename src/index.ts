import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  type ExtensionAPI,
  type ProviderConfig,
} from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "./auth.js";
import { streamAnthropicOAuth } from "./stream.js";

const DEFAULT_OPUS_4_7: NonNullable<ProviderConfig["models"]>[number] = {
  id: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  api: "anthropic-messages",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1000000,
  maxTokens: 128000,
  compat: undefined,
};

function ensureClaudeCodeSymlink() {
  const target = join(homedir(), ".pi");
  const link = join(homedir(), ".Claude Code");
  if (existsSync(target) && !existsSync(link)) {
    try {
      symlinkSync(target, link);
    } catch { }
  }
}

function getAnthropicModels(): NonNullable<ProviderConfig["models"]> {
  const modelRegistry = ModelRegistry.create(AuthStorage.inMemory());
  const models: NonNullable<ProviderConfig["models"]> = modelRegistry
    .getAll()
    .filter((model) => model.provider === "anthropic")
    .map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api ?? "anthropic-messages",
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: model.compat,
    }));

  if (!models.some((model) => model.id === DEFAULT_OPUS_4_7.id)) {
    models.push(DEFAULT_OPUS_4_7);
  }

  return models;
}

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();
  const models = getAnthropicModels();

  pi.registerProvider("anthropic", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "ANTHROPIC_MAX_API_KEY",
    api: "anthropic-messages",
    models,
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
