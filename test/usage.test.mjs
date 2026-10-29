import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerUsageCommand } from "../.test-dist/usage.js";

function mockFetch(t, usageFetch, profileFetch = async () => Response.json({
  organization: { organization_type: "claude_pro" },
})) {
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (url === "https://api.anthropic.com/api/oauth/profile") return profileFetch(url, options);
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    return usageFetch(url, options);
  });
}

function setup(token = "sk-ant-oat-test", { mode = "rpc", theme } = {}) {
  let command;
  const notifications = [];
  registerUsageCommand({
    registerCommand(name, definition) {
      assert.equal(name, "usage");
      command = definition;
    },
  });
  return {
    notifications,
    run: () => command.handler("", {
      mode,
      modelRegistry: {
        async getApiKeyForProvider(provider) {
          assert.equal(provider, "anthropic");
          return token;
        },
      },
      ui: { theme, notify: (text, level) => notifications.push({ text, level }) },
    }),
  };
}

test("/usage fetches OAuth limits and displays percentages and resets", async (t) => {
  const reset = "2030-01-02T03:04:05Z";
  t.mock.method(Date, "now", () => Date.parse(reset) - 79 * 60 * 60 * 1000);
  mockFetch(t, async (url, options) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(options.headers.Authorization, "Bearer sk-ant-oat-test");
    assert.equal(options.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({
      five_hour: { utilization: 23.5, resets_at: reset },
      seven_day: { utilization: 0, resets_at: null },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 80, resets_at: reset },
    });
  });
  const command = setup();
  await command.run();
  assert.deepEqual(command.notifications, [{
    text: `Claude usage\nPlan: Pro\n5-hour:               [█████░░░░░░░░░░░░░░░] 23.5% used · resets in 3d 7h\nWeekly:               [░░░░░░░░░░░░░░░░░░░░] 0% used\nWeekly (Sonnet only): [████████████████░░░░] 80% used · resets in 3d 7h`,
    level: "info",
  }]);
});

test("/usage reads Fable from the modern limits array without duplicating legacy windows", async (t) => {
  const reset = "2030-01-02T03:04:05.729307+00:00";
  mockFetch(t, async () => Response.json({
    five_hour: { utilization: 41, resets_at: reset },
    seven_day: { utilization: 20, resets_at: reset },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 9 },
    limits: [
      { kind: "session", group: "session", percent: 41, resets_at: reset, scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 20, resets_at: reset, scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 38, resets_at: reset,
        scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 0,
        scope: { model: { display_name: "Future Model" } }, is_active: false },
      { kind: "daily", group: "daily", percent: 12 },
      { kind: "weekly_scoped", percent: null },
    ],
  }));
  const command = setup();
  await command.run();
  const { text, level } = command.notifications[0];
  assert.equal(level, "info");
  assert.match(text, /Weekly \(Fable only\): +\[████████░░░░░░░░░░░░\] 38% used · resets/);
  assert.match(text, /Weekly \(Future Model only\): +\[░░░░░░░░░░░░░░░░░░░░\] 0% used/);
  assert.match(text, /Weekly \(Sonnet only\): +\[██░░░░░░░░░░░░░░░░░░\] 9% used/);
  assert.match(text, /Daily: +\[██░░░░░░░░░░░░░░░░░░\] 12% used/);
  assert.equal(text.match(/5-hour:/g).length, 1);
  assert.equal(text.match(/Weekly:/g).length, 1);
});

test("/usage formats resets as compact relative durations", async (t) => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  for (const [offset, expected] of [
    [79 * 60 * 60 * 1000, " · resets in 3d 7h"],
    [72 * 60 * 60 * 1000, " · resets in 3d"],
    [135 * 60 * 1000, " · resets in 2h 15m"],
    [60 * 60 * 1000, " · resets in 1h"],
    [59 * 60 * 1000, " · resets in 59m"],
    [1000, " · resets in 1m"],
    [0, " · resets now"],
    [-1000, " · resets now"],
    ["invalid", ""],
    [null, ""],
    [undefined, ""],
  ]) {
    const reset = typeof offset === "number" ? new Date(now + offset).toISOString() : offset;
    mockFetch(t, async () => Response.json({
      five_hour: { utilization: 50, resets_at: reset },
      limits: [{ kind: "weekly_scoped", percent: 50, resets_at: reset,
        scope: { model: { display_name: "Fable" } } }],
    }));
    const command = setup();
    await command.run();
    assert.equal(command.notifications[0].level, "info");
    const rows = command.notifications[0].text.split("\n").slice(2);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.ok(row.endsWith(`50% used${expected}`), row);
  }
});

test("/usage displays the live plan and Max multiplier from the OAuth profile", async (t) => {
  for (const [organization, expected] of [
    [{ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" }, "Max (20x)"],
    [{ organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" }, "Max (5x)"],
    [{ organization_type: "claude_max" }, "Max"],
    [{ organization_type: "claude_pro" }, "Pro"],
    [{ organization_type: "claude_team" }, "Team"],
    [{ organization_type: "claude_enterprise" }, "Enterprise"],
    [{ rate_limit_tier: "default_claude_max_20x" }, "Max (20x)"],
  ]) {
    mockFetch(t, async () => Response.json({ five_hour: { utilization: 10 } }), async (_url, options) => {
      assert.equal(options.headers.Authorization, "Bearer sk-ant-oat-test");
      assert.equal(options.headers.Accept, "application/json");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ organization, account: { email: "private@example.com" } });
    });
    const command = setup();
    await command.run();
    assert.ok(command.notifications[0].text.split("\n").includes(`Plan: ${expected}`));
    assert.doesNotMatch(command.notifications[0].text, /private@example.com/);
  }
});

test("/usage consumes usage data without waiting for the profile response", { timeout: 1000 }, async (t) => {
  let usageRead;
  const usageReadPromise = new Promise((resolve) => { usageRead = resolve; });
  mockFetch(t, async () => ({
    ok: true,
    async json() {
      usageRead();
      return { five_hour: { utilization: 10 } };
    },
  }), async () => {
    await usageReadPromise;
    return Response.json({ organization: { organization_type: "claude_pro" } });
  });
  const command = setup();
  await command.run();
  assert.equal(command.notifications[0].level, "info");
});

test("/usage still shows limits when profile lookup fails or has no plan", async (t) => {
  for (const profileFetch of [
    async () => new Response("private profile details", { status: 403 }),
    async () => { throw new Error("private network details"); },
    async () => new Response("not JSON"),
    async () => Response.json({}),
    async () => Response.json(null),
  ]) {
    mockFetch(t, async () => Response.json({ five_hour: { utilization: 10 } }), profileFetch);
    const command = setup();
    await command.run();
    const { text, level } = command.notifications[0];
    assert.equal(level, "info");
    assert.match(text, /Plan: unavailable/);
    assert.match(text, /5-hour: +\[██░░░░░░░░░░░░░░░░░░\] 10% used/);
    assert.doesNotMatch(text, /private|not JSON/);
  }
});

test("/usage requires an OAuth token, not an API key", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not fetch without OAuth"));
  for (const token of [undefined, "sk-ant-api-test"]) {
    const command = setup(token ?? "");
    await command.run();
    assert.match(command.notifications[0].text, /\/login/);
    assert.equal(command.notifications[0].level, "warning");
  }
});

test("/usage handles missing or invalid usage windows", async (t) => {
  mockFetch(t, async () => Response.json({
    five_hour: null,
    seven_day: { utilization: "invalid" },
  }));
  const command = setup();
  await command.run();
  assert.deepEqual(command.notifications, [{ text: "Claude usage\nPlan: Pro\nNo Claude usage data available.", level: "info" }]);
});

test("/usage includes Fable and newly returned usage windows", async (t) => {
  mockFetch(t, async () => Response.json({
    five_hour: { utilization: 10 },
    seven_day_fable: { utilization: 42.5, resets_at: "invalid" },
    seven_day_oauth_apps: { utilization: 0 },
    seven_day_future_model: { utilization: 5 },
    iguana_necktie: null,
    server_metadata: "not a window",
  }));
  const command = setup();
  await command.run();
  const { text, level } = command.notifications[0];
  assert.equal(level, "info");
  assert.match(text, /Weekly \(Fable only\): +\[█████████░░░░░░░░░░░\] 42\.5% used/);
  assert.match(text, /Weekly \(OAuth Apps only\): +\[░░░░░░░░░░░░░░░░░░░░\] 0% used/);
  assert.match(text, /Weekly \(Future Model only\): +\[█░░░░░░░░░░░░░░░░░░░\] 5% used/);
  assert.doesNotMatch(text, /Invalid Date|Server Metadata|Iguana/);
});

test("/usage maps iguana_necktie to Fable and ignores unknown codename keys", async (t) => {
  for (const [limits, expected] of [
    [undefined, 12],
    [[{ kind: "weekly_scoped", percent: 96, scope: { model: { display_name: "Fable" } } }], 96],
  ]) {
    mockFetch(t, async () => Response.json({
      five_hour: { utilization: 5 },
      iguana_necktie: { utilization: 12 },
      tangelo: { utilization: 30 },
      limits,
    }));
    const command = setup();
    await command.run();
    const { text, level } = command.notifications[0];
    assert.equal(level, "info");
    assert.equal(text.match(/Fable only/g).length, 1);
    assert.match(text, new RegExp(`Weekly \\(Fable only\\): +\\[[█░]{20}\\] ${expected}% used`));
    assert.doesNotMatch(text, /Iguana|Tangelo|30%/);
  }
});

test("/usage bars are fixed-width and clamp visually without changing reported percentages", async (t) => {
  for (const [percent, bar] of [
    [-5, "░░░░░░░░░░░░░░░░░░░░"],
    [0, "░░░░░░░░░░░░░░░░░░░░"],
    [23.5, "█████░░░░░░░░░░░░░░░"],
    [50, "██████████░░░░░░░░░░"],
    [100, "████████████████████"],
    [125, "████████████████████"],
  ]) {
    mockFetch(t, async () => Response.json({
      five_hour: { utilization: percent },
      limits: [{ kind: "weekly_scoped", group: "weekly", percent,
        scope: { model: { display_name: "Fable" } } }],
    }));
    const command = setup();
    await command.run();
    const { text, level } = command.notifications[0];
    assert.equal(level, "info");
    const rows = text.split("\n").slice(2);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.ok(row.endsWith(`[${bar}] ${percent}% used`), row);
  }
});

test("/usage aligns bars by visible label width, including wide model names", async (t) => {
  mockFetch(t, async () => Response.json({
    extra_usage: { is_enabled: true, utilization: 25 },
    limits: [
      { kind: "session", percent: 50 },
      { kind: "weekly_all", percent: 25 },
      { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "模型" } } },
    ],
  }));
  const command = setup();
  await command.run();
  const rows = command.notifications[0].text.split("\n").slice(2);
  assert.equal(rows.length, 5);
  const columns = rows.map((row) => visibleWidth(row.slice(0, row.indexOf("["))));
  assert.ok(columns.every((column) => column === columns[0]));
});

test("/usage uses theme colors and bold percentages only in TUI mode", async (t) => {
  mockFetch(t, async () => Response.json({
    five_hour: { utilization: 50 },
    seven_day: { utilization: 100 },
    extra_usage: { is_enabled: true, utilization: 25 },
  }));
  const colors = { text: 37, accent: 36, dim: 90, muted: 90 };
  const theme = {
    fg: (color, text) => `\x1b[${colors[color]}m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const tui = setup("sk-ant-oat-test", { mode: "tui", theme });
  await tui.run();
  const styled = tui.notifications[0].text;
  assert.ok(styled.includes(theme.fg("accent", "█".repeat(10))));
  assert.ok(styled.includes(theme.fg("dim", "░".repeat(10))));
  for (const percent of [50, 100, 25]) {
    assert.ok(styled.includes(theme.bold(theme.fg("text", `${percent}%`))));
  }
  const rpc = setup("sk-ant-oat-test", { mode: "rpc", theme });
  await rpc.run();
  assert.equal(stripVTControlCharacters(styled), rpc.notifications[0].text);
  assert.equal(stripVTControlCharacters(rpc.notifications[0].text), rpc.notifications[0].text);
});

test("/usage shows extra usage status, spending, and monthly limit", async (t) => {
  for (const [extra, expected] of [
    [{ is_enabled: false }, "Extra usage: disabled"],
    [{ is_enabled: true, utilization: 25, used_credits: 250, monthly_limit: 1000, currency: "USD" },
      "Extra usage: [█████░░░░░░░░░░░░░░░] 25% used · enabled · spent 2.50 USD · monthly limit 10.00 USD"],
    [{ is_enabled: true, utilization: 0, used_credits: 0, monthly_limit: null },
      "Extra usage: [░░░░░░░░░░░░░░░░░░░░] 0% used · enabled · spent 0.00 USD"],
    [{ is_enabled: true, used_credits: 123, monthly_limit: 500, currency: "EUR" },
      "Extra usage: enabled · spent 1.23 EUR · monthly limit 5.00 EUR"],
  ]) {
    mockFetch(t, async () => Response.json({ extra_usage: extra }));
    const command = setup();
    await command.run();
    assert.ok(command.notifications[0].text.includes(expected));
    assert.equal(command.notifications[0].level, "info");
  }
});

test("/usage reports HTTP failures without exposing response bodies", async (t) => {
  for (const status of [401, 403, 429, 500]) {
    mockFetch(t, async () => new Response("secret details", { status }));
    const command = setup();
    await command.run();
    assert.equal(command.notifications[0].level, "error");
    assert.match(command.notifications[0].text, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(command.notifications[0].text, /secret details/);
    if (status === 401 || status === 403) assert.match(command.notifications[0].text, /\/login/);
  }
});

test("/usage preserves distinct surfaces for the same model", async (t) => {
  mockFetch(t, async () => Response.json({ limits: [
    { kind: "weekly_scoped", group: "weekly", percent: 10,
      scope: { model: { display_name: "Fable" }, surface: "claude_code" } },
    { kind: "weekly_scoped", group: "weekly", percent: 80,
      scope: { model: { display_name: "Fable" }, surface: "claude_ai" } },
  ] }));
  const command = setup();
  await command.run();
  const { text, level } = command.notifications[0];
  assert.equal(level, "info");
  assert.equal(text.split("\n").slice(2).length, 2);
  assert.match(text, /Weekly \(Fable only · Claude Code\): +\[[█░]{20}\] 10% used/);
  assert.match(text, /Weekly \(Fable only · Claude Ai\): +\[[█░]{20}\] 80% used/);
});

test("/usage tolerates malformed fields without losing valid windows", async (t) => {
  mockFetch(t, async () => Response.json({
    five_hour: { utilization: 20, resets_at: { toString: null } },
    limits: [
      null, false, 7, "invalid",
      { kind: 42, percent: 10 },
      { kind: "weekly_scoped", group: {}, percent: "invalid",
        scope: { model: { display_name: {} }, surface: {} } },
      { kind: "weekly_scoped", percent: 30, scope: { model: { display_name: "Fable" } } },
    ],
    extra_usage: { is_enabled: true, used_credits: 123, currency: {} },
  }));
  const command = setup();
  await command.run();
  const { text, level } = command.notifications[0];
  assert.equal(level, "info");
  assert.match(text, /5-hour: +\[[█░]{20}\] 20% used/);
  assert.match(text, /Weekly \(Fable only\): +\[[█░]{20}\] 30% used/);
  assert.match(text, /spent 1\.23 USD/);
  assert.doesNotMatch(text, /\[object Object\]|Invalid Date|resets/);
});

test("/usage sanitizes invalid JSON errors instead of echoing the response", async (t) => {
  mockFetch(t, async () => new Response("private-provider-response", { status: 200 }));
  const command = setup();
  await command.run();
  assert.deepEqual(command.notifications, [{
    text: "Could not parse Anthropic usage response.", level: "error",
  }]);
});

test("/usage rejects non-object response payloads with a safe error", async (t) => {
  for (const payload of [null, [], 42, "private-provider-response"]) {
    mockFetch(t, async () => Response.json(payload));
    const command = setup();
    await command.run();
    assert.deepEqual(command.notifications, [{
      text: "Invalid Anthropic usage response.", level: "error",
    }]);
  }
});

test("/usage reports network and JSON errors", async (t) => {
  for (const [fetcher, expected] of [
    [async () => { throw new TypeError("fetch failed: private network details"); },
      "Could not reach Anthropic usage API. Check your connection."],
    [async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
      "Anthropic usage request timed out."],
    [async () => new Response("not json"), "Could not parse Anthropic usage response."],
  ]) {
    mockFetch(t, fetcher);
    const command = setup();
    await command.run();
    assert.deepEqual(command.notifications, [{ text: expected, level: "error" }]);
  }
});
