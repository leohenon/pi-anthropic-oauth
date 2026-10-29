import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isClaudeOAuthAccessToken, USER_AGENT } from "./auth.js";

type UsageWindow = {
  utilization: number;
  resets_at?: string | null;
};

type UsageLimit = {
  kind?: string;
  group?: string;
  percent?: number | null;
  utilization?: number | null;
  resets_at?: string | null;
  scope?: {
    model?: { display_name?: string | null } | null;
    surface?: string | null;
  } | null;
};

type ExtraUsage = {
  is_enabled?: boolean;
  utilization?: number | null;
  used_credits?: number | null;
  monthly_limit?: number | null;
  currency?: string | null;
  decimal_places?: number | null;
};

type OAuthUsage = Record<string, unknown> & {
  limits?: UsageLimit[] | null;
  extra_usage?: ExtraUsage | null;
};

type OAuthProfile = {
  organization?: {
    organization_type?: string | null;
    rate_limit_tier?: string | null;
  } | null;
};

function words(text: string): string {
  return text
    .split("_")
    .map((word) =>
      word === "oauth" ? "OAuth" : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function usageLabel(key: string): string | undefined {
  if (key === "five_hour") return "5-hour";
  if (key === "seven_day") return "Weekly";
  if (key === "iguana_necktie") return "Weekly (Fable only)";
  if (key.startsWith("seven_day_")) {
    return `Weekly (${words(key.slice("seven_day_".length))} only)`;
  }
  return undefined;
}

async function fetchPlan(headers: Record<string, string>): Promise<string> {
  try {
    const response = await fetch(
      "https://api.anthropic.com/api/oauth/profile",
      {
        headers,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return `Plan: unavailable (HTTP ${response.status})`;
    const profile = (await response.json()) as OAuthProfile;
    const organization = profile?.organization;
    const orgType =
      typeof organization?.organization_type === "string"
        ? organization.organization_type
        : "";
    const tier =
      typeof organization?.rate_limit_tier === "string"
        ? organization.rate_limit_tier
        : "";
    const type =
      orgType.replace(/^claude_/, "") ||
      ["max", "pro", "team", "enterprise", "free"].find((plan) =>
        tier.split("_").includes(plan),
      );
    if (!type) return "Plan: unavailable (no plan details returned)";
    const multiplier =
      type === "max" ? tier.match(/(?:^|_)max_(\d+x)(?:_|$)/)?.[1] : undefined;
    return `Plan: ${words(type)}${multiplier ? ` (${multiplier})` : ""}`;
  } catch {
    // Profile failures must not hide usage; don't expose profile/error payloads.
    return "Plan: unavailable (could not fetch profile)";
  }
}

function formatPercent(percent: number, theme?: Theme): string {
  const width = 20;
  const filled = Math.round(
    (Math.max(0, Math.min(100, percent)) / 100) * width,
  );
  const full = "█".repeat(filled);
  const empty = "░".repeat(width - filled);
  const bar = theme
    ? theme.fg("accent", full) + theme.fg("dim", empty)
    : full + empty;
  const display = `${Math.round(percent * 10) / 10}%`;
  const value = theme ? theme.bold(theme.fg("text", display)) : display;
  return `[${bar}] ${value} used`;
}

function formatReset(resetsAt: string | null | undefined, now: number): string {
  if (typeof resetsAt !== "string" || !resetsAt) return "";
  const remaining = Date.parse(resetsAt) - now;
  if (!Number.isFinite(remaining)) return "";
  if (remaining <= 0) return " · resets now";
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  let duration = `${minutes}m`;
  if (days) duration = `${days}d${hours ? ` ${hours}h` : ""}`;
  else if (hours) duration = `${hours}h${mins ? ` ${mins}m` : ""}`;
  return ` · resets in ${duration}`;
}

function rowRank(label: string): number {
  if (label === "5-hour" || label.startsWith("5-hour (")) return 0;
  if (label === "Weekly") return 1;
  if (label.startsWith("Weekly (")) return 2;
  if (label === "Extra usage") return 4;
  return 3;
}

function formatUsage(usage: OAuthUsage, theme?: Theme): string[] {
  const now = Date.now();
  const lines = new Map<string, string>();
  const addWindow = (
    label: string,
    percent: unknown,
    resetsAt?: string | null,
  ) => {
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      lines.has(label)
    )
      return;
    const reset = formatReset(resetsAt, now);
    lines.set(
      label,
      `${formatPercent(percent, theme)}${theme ? theme.fg("muted", reset) : reset}`,
    );
  };

  // Modern responses include scoped limits such as Fable here, even if inactive.
  if (Array.isArray(usage.limits)) {
    for (const limit of usage.limits) {
      if (!limit) continue;
      const kind = typeof limit.kind === "string" ? limit.kind : "";
      const group = typeof limit.group === "string" ? limit.group : "";
      const name = limit.scope?.model?.display_name;
      const model = typeof name === "string" ? name : "";
      const surface =
        typeof limit.scope?.surface === "string" ? limit.scope.surface : "";
      const scopes = [];
      if (model) scopes.push(`${model} only`);
      else if (kind === "weekly_scoped") scopes.push("model only");
      if (surface) scopes.push(words(surface));
      const scope = scopes.join(" · ");
      let base = words(kind || group || "limit");
      if (kind === "session") base = "5-hour";
      else if (group === "weekly" || kind.startsWith("weekly")) base = "Weekly";
      const value = limit.percent ?? limit.utilization;
      const percent =
        value == null && model && kind === "weekly_scoped" ? 0 : value;
      addWindow(scope ? `${base} (${scope})` : base, percent, limit.resets_at);
    }
  }

  for (const [key, value] of Object.entries(usage)) {
    const label = usageLabel(key);
    if (!label || !value || typeof value !== "object") continue;
    const window = value as UsageWindow;
    addWindow(label, window.utilization, window.resets_at);
  }

  const extra = usage.extra_usage;
  if (extra) {
    let status = "status unknown";
    if (extra.is_enabled === true) status = "enabled";
    if (extra.is_enabled === false) status = "disabled";
    const details = [];
    if (
      typeof extra.utilization === "number" &&
      Number.isFinite(extra.utilization)
    ) {
      details.push(formatPercent(extra.utilization, theme));
    }
    details.push(status);
    const currency =
      typeof extra.currency === "string" ? extra.currency.trim() : "";
    const places =
      typeof extra.decimal_places === "number" &&
      Number.isInteger(extra.decimal_places) &&
      extra.decimal_places >= 0 &&
      extra.decimal_places <= 4
        ? extra.decimal_places
        : 2;
    const money = (minor: number) =>
      `${(minor / 10 ** places).toFixed(places)} ${currency || "USD"}`;
    if (
      typeof extra.used_credits === "number" &&
      Number.isFinite(extra.used_credits)
    ) {
      details.push(`spent ${money(extra.used_credits)}`);
    }
    if (
      typeof extra.monthly_limit === "number" &&
      Number.isFinite(extra.monthly_limit)
    ) {
      details.push(`monthly limit ${money(extra.monthly_limit)}`);
    }
    lines.set("Extra usage", details.join(" · "));
  }
  const rows = [...lines].sort(([a], [b]) => rowRank(a) - rowRank(b));
  const labelWidth = Math.max(0, ...rows.map(([label]) => visibleWidth(label)));
  return rows.map(([label, value]) => {
    const prefix = `${label}:${" ".repeat(labelWidth - visibleWidth(label) + 1)}`;
    return `${theme ? theme.fg("text", prefix) : prefix}${value}`;
  });
}

async function fetchUsage(
  headers: Record<string, string>,
): Promise<OAuthUsage> {
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new Error(
      timedOut
        ? "Anthropic usage request timed out."
        : "Could not reach Anthropic usage API. Check your connection.",
    );
  }
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " Try /login again."
        : "";
    throw new Error(
      `Anthropic usage request failed (HTTP ${response.status}).${hint}`,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Could not parse Anthropic usage response.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid Anthropic usage response.");
  }
  return data as OAuthUsage;
}

export function registerUsageCommand(pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description:
      "Show your Claude plan, usage limits, reset times, and extra usage",
    handler: async (_args, ctx) => {
      try {
        // Resolve through Pi so expired OAuth credentials are refreshed normally.
        const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
        if (!token || !isClaudeOAuthAccessToken(token)) {
          ctx.ui.notify(
            "Run /login and choose Claude Pro/Max to view usage.",
            "warning",
          );
          return;
        }

        const headers = {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        };
        const [usage, plan] = await Promise.all([
          fetchUsage(headers),
          fetchPlan(headers),
        ]);
        const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
        const lines = formatUsage(usage, theme);
        const heading = theme
          ? theme.bold(theme.fg("text", "Claude usage"))
          : "Claude usage";
        const planText = theme ? theme.fg("text", plan) : plan;
        ctx.ui.notify(
          `${heading}\n${planText}\n${lines.length ? lines.join("\n") : "No Claude usage data available."}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error
            ? error.message
            : "Could not fetch Claude usage.",
          "error",
        );
      }
    },
  });
}
