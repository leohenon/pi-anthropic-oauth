export const CLAUDE_CODE_VERSION_ENV = "PI_ANTHROPIC_OAUTH_CLAUDE_CODE_VERSION";
const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280";

/**
 * Claude Code version advertised to the API (user agent and billing header).
 *
 * Anthropic gates new models on the client version; override with
 * PI_ANTHROPIC_OAUTH_CLAUDE_CODE_VERSION when a newer one is required.
 */
export function getClaudeCodeVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[CLAUDE_CODE_VERSION_ENV]?.trim() || DEFAULT_CLAUDE_CODE_VERSION;
}

/**
 * User agent matching the current Claude Code CLI client. The classifier
 * rejects the older `claude-code/<ver>` form for premium models.
 */
export function makeClaudeCodeUserAgent(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `claude-cli/${getClaudeCodeVersion(env)} (external, cli)`;
}
