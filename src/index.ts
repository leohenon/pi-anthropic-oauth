import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "./auth.js";
import { streamAnthropicOAuth } from "./stream.js";

const DEFAULT_MODELS: NonNullable<ProviderConfig["models"]> = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: undefined,
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: undefined,
  },
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

function getAnthropicModels(): NonNullable<ProviderConfig["models"]> {
  const models: NonNullable<ProviderConfig["models"]> = [];

  // Pi 0.80.x removed the synchronous `ModelRegistry.create(AuthStorage.inMemory())`
  // facade this used to read the host's known anthropic models from. Read the
  // catalog the host maintains on disk instead, so newer models (sonnet, haiku, …)
  // stay selectable; fall back to the bundled defaults if it's missing or its
  // shape changes — this must never throw at extension-load time.
  try {
    const storePath = join(homedir(), ".pi", "agent", "models-store.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    const stored = store?.anthropic?.models;
    if (Array.isArray(stored)) {
      for (const model of stored) {
        if (!model?.id) continue;
        if (model.provider && model.provider !== "anthropic") continue;
        models.push({ ...model, api: model.api ?? "anthropic-messages" });
      }
    }
  } catch {
    // best-effort: the defaults below are always registered
  }

  for (const defaultModel of DEFAULT_MODELS) {
    if (!models.some((model) => model.id === defaultModel.id)) {
      models.push(defaultModel);
    }
  }

  return models;
}

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();
  const models = getAnthropicModels();

  pi.registerProvider("anthropic", {
    baseUrl: "https://api.anthropic.com",
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
