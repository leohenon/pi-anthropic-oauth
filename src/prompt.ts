const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@earendil-works/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

export const PI_REWRITE_MODE_ENV = "PI_ANTHROPIC_OAUTH_REWRITE_MODE";
export const PI_REWRITE_PATTERN_ENV = "PI_ANTHROPIC_OAUTH_REWRITE_PATTERN";

export type PiRewriteMode = "aggressive" | "path-safe" | "technical-safe" | "custom";

const DEFAULT_PI_REWRITE_MODE: PiRewriteMode = "aggressive";
const PI_REWRITE_PATTERN_SOURCES: Record<Exclude<PiRewriteMode, "custom">, string> = {
  aggressive: String.raw`\b[Pp]i\b`,
  "path-safe": String.raw`(?<![/\\])\b[Pp]i\b`,
  "technical-safe": String.raw`(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])`,
};

const PI_REWRITE_MODES = new Set<PiRewriteMode>([
  "aggressive",
  "path-safe",
  "technical-safe",
  "custom",
]);

type MessageContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

export function buildAnthropicSystemPrompt(
  systemPrompt: string | undefined,
  isOAuth: boolean,
): MessageContentBlock[] | undefined {
  const blocks: MessageContentBlock[] = [];

  if (isOAuth) {
    blocks.push({
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
      cache_control: { type: "ephemeral" },
    });
  }

  const sanitized = systemPrompt ? sanitizeSystemText(systemPrompt) : "";
  if (sanitized) {
    blocks.push({
      type: "text",
      text: sanitized,
      cache_control: { type: "ephemeral" },
    });
  }

  return blocks.length > 0 ? blocks : undefined;
}

export function sanitizeSystemText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    const lower = paragraph.toLowerCase();
    if (lower.includes("you are pi")) return false;
    return !PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor));
  });

  return filtered
    .join("\n\n")
    .replace(resolvePiRewritePattern(env), "Claude Code")
    .trim();
}

function resolvePiRewritePattern(env: NodeJS.ProcessEnv): RegExp {
  const mode = parsePiRewriteMode(env[PI_REWRITE_MODE_ENV]);
  if (mode === "custom") return compileCustomPiRewritePattern(env[PI_REWRITE_PATTERN_ENV]);
  return new RegExp(PI_REWRITE_PATTERN_SOURCES[mode], "g");
}

function parsePiRewriteMode(value: string | undefined): PiRewriteMode {
  if (!value?.trim()) return DEFAULT_PI_REWRITE_MODE;
  const mode = value.trim().toLowerCase();
  if (PI_REWRITE_MODES.has(mode as PiRewriteMode)) return mode as PiRewriteMode;
  throw new Error(
    `Invalid ${PI_REWRITE_MODE_ENV}: ${value}. Expected one of ${Array.from(PI_REWRITE_MODES).join(", ")}.`,
  );
}

function compileCustomPiRewritePattern(value: string | undefined): RegExp {
  const pattern = value?.trim();
  if (!pattern) {
    throw new Error(`${PI_REWRITE_PATTERN_ENV} must be set when ${PI_REWRITE_MODE_ENV}=custom.`);
  }

  const parsed = parseRegexLiteral(pattern) ?? { source: pattern, flags: "" };
  const flags = parsed.flags.includes("g") ? parsed.flags : `${parsed.flags}g`;
  try {
    return new RegExp(parsed.source, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${PI_REWRITE_PATTERN_ENV}: ${message}`);
  }
}

function parseRegexLiteral(value: string): { source: string; flags: string } | undefined {
  if (!value.startsWith("/")) return undefined;

  for (let index = value.length - 1; index > 0; index--) {
    if (value[index] !== "/" || isEscaped(value, index)) continue;
    return { source: value.slice(1, index), flags: value.slice(index + 1) };
  }

  return undefined;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}
