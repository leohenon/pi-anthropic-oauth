import { createHash, randomUUID } from "node:crypto";
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";

export const REQUIRED_OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
] as const;

type ThinkingConfig =
  | { type: "adaptive"; display: "summarized" }
  | {
      type: "enabled";
      budget_tokens: number;
      display: "summarized";
    };

export type ThinkingRequest = {
  thinking?: ThinkingConfig;
  outputConfig?: { effort: string };
};

const DEFAULT_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 20480,
  xhigh: 32000,
  max: 32000,
};

export function buildThinkingRequest(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  maxTokens: number,
): ThinkingRequest {
  const level = options?.reasoning;
  if (!level || !model.reasoning || maxTokens <= 1) return {};

  const compat = model.compat as
    | { forceAdaptiveThinking?: boolean }
    | undefined;
  if (compat?.forceAdaptiveThinking === true) {
    return {
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: mapThinkingLevelToEffort(model, level) },
    };
  }

  const configuredBudget = (
    options.thinkingBudgets as Partial<Record<ThinkingLevel, number>> | undefined
  )?.[level];
  const requestedBudget =
    configuredBudget ?? DEFAULT_THINKING_BUDGETS[level];

  return {
    thinking: {
      type: "enabled",
      budget_tokens: Math.min(requestedBudget, maxTokens - 1),
      display: "summarized",
    },
  };
}

export function mapThinkingLevelToEffort(
  model: Model<Api>,
  level: ThinkingLevel,
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;

  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
  }
}

export function createClaudeCodeSessionId(context: Context): string {
  const firstTimestamp = context.messages[0]?.timestamp;
  if (firstTimestamp === undefined) return randomUUID();

  const bytes = createHash("sha256")
    .update("pi-anthropic-oauth\0")
    .update(String(firstTimestamp))
    .digest()
    .subarray(0, 16);

  // Produce an RFC 4122 UUID while keeping the identifier deterministic for
  // every request that belongs to the same persisted Pi conversation.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
