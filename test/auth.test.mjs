import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import {
  loginAnthropic,
  refreshAnthropicToken,
} from "../.test-dist/auth.js";

const CALLBACK_PORT = 53692;
const LOCAL_REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

function tokenSuccess(overrides = {}) {
  return new Response(
    JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function callbackRequest(callbackUrl) {
  const url = new URL(callbackUrl);
  url.hostname = "127.0.0.1";
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function callbacks(overrides = {}) {
  return {
    onAuth() {},
    async onPrompt() {
      throw new Error("Unexpected paste prompt");
    },
    ...overrides,
  };
}

const futureCredentials = {
  access: "old-access",
  refresh: "old-refresh",
  expires: Date.now() + 60_000,
};

test("uses the exact initiated local redirect and rejects an arbitrary pasted callback", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let exchangeBody;
  let callbackResponse;
  globalThis.fetch = async (_url, init) => {
    exchangeBody = JSON.parse(init.body);
    return tokenSuccess();
  };

  try {
    await loginAnthropic(callbacks({
      onAuth({ url }) {
        const authorizeUrl = new URL(url);
        assert.equal(authorizeUrl.searchParams.get("redirect_uri"), LOCAL_REDIRECT_URI);
        const state = authorizeUrl.searchParams.get("state");
        callbackResponse = callbackRequest(
          `${LOCAL_REDIRECT_URI}?code=local-code&state=${state}`,
        );
      },
    }));

    assert.equal(await callbackResponse, 200);
    assert.equal(exchangeBody.redirect_uri, LOCAL_REDIRECT_URI);

    let tokenExchangeAttempted = false;
    globalThis.fetch = async () => {
      tokenExchangeAttempted = true;
      return tokenSuccess();
    };

    let state;
    await assert.rejects(
      loginAnthropic(callbacks({
        onAuth({ url }) {
          state = new URL(url).searchParams.get("state");
        },
        async onManualCodeInput() {
          return `https://attacker.example/callback?code=stolen&state=${state}`;
        },
      })),
      /Could not parse authorization callback input/,
    );
    assert.equal(tokenExchangeAttempted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the default redirect when local server startup fails", { concurrency: false }, async () => {
  const holder = createServer();
  await listen(holder);
  const originalFetch = globalThis.fetch;
  let exchangeBody;
  globalThis.fetch = async (_url, init) => {
    exchangeBody = JSON.parse(init.body);
    return tokenSuccess();
  };

  try {
    let state;
    await loginAnthropic(callbacks({
      onAuth({ url }) {
        const authorizeUrl = new URL(url);
        assert.equal(authorizeUrl.searchParams.get("redirect_uri"), REDIRECT_URI);
        state = authorizeUrl.searchParams.get("state");
      },
      async onPrompt() {
        return `${REDIRECT_URI}?code=remote-code&state=${state}`;
      },
    }));
    assert.equal(exchangeBody.redirect_uri, REDIRECT_URI);
  } finally {
    globalThis.fetch = originalFetch;
    await close(holder);
  }
});

test("callback timeout falls back without losing the initiated local redirect", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let exchangeBody;
  let state;

  globalThis.setTimeout = (callback, _delay, ...args) =>
    originalSetTimeout(callback, 0, ...args);
  globalThis.fetch = async (_url, init) => {
    exchangeBody = JSON.parse(init.body);
    return tokenSuccess();
  };

  try {
    await loginAnthropic(callbacks({
      onAuth({ url }) {
        state = new URL(url).searchParams.get("state");
      },
      async onManualCodeInput() {
        return new Promise(() => {});
      },
      async onPrompt() {
        return `${LOCAL_REDIRECT_URI}?code=late-local-code&state=${state}`;
      },
    }));

    assert.equal(exchangeBody.redirect_uri, LOCAL_REDIRECT_URI);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("propagates manual input rejection and releases the callback port", { concurrency: false }, async () => {
  const cancellation = new Error("manual input cancelled");
  let prompted = false;

  await assert.rejects(
    loginAnthropic(callbacks({
      async onManualCodeInput() {
        throw cancellation;
      },
      async onPrompt() {
        prompted = true;
        return "unused";
      },
    })),
    (error) => error === cancellation,
  );
  assert.equal(prompted, false);

  const probe = createServer();
  await listen(probe);
  await close(probe);
});

test("wrong-state callback returns 400 and a later valid callback completes login", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => tokenSuccess();
  let callbackFlow;

  try {
    await loginAnthropic(callbacks({
      onAuth({ url }) {
        const state = new URL(url).searchParams.get("state");
        callbackFlow = (async () => {
          const wrongStatus = await callbackRequest(
            `${LOCAL_REDIRECT_URI}?code=wrong&state=wrong-state`,
          );
          const validStatus = await callbackRequest(
            `${LOCAL_REDIRECT_URI}?code=valid&state=${state}`,
          );
          return { wrongStatus, validStatus };
        })();
      },
    }));

    assert.deepEqual(await callbackFlow, {
      wrongStatus: 400,
      validStatus: 200,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parses numeric and HTTP-date Retry-After values and caps delays", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  let attempt = 0;

  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(callback, 0, ...args);
  };
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) {
      return new Response("busy", {
        status: 429,
        headers: { "retry-after": "1.25" },
      });
    }
    if (attempt === 2) {
      return new Response("still busy", {
        status: 503,
        headers: { "retry-after": new Date(Date.now() + 60_000).toUTCString() },
      });
    }
    return tokenSuccess();
  };

  try {
    await refreshAnthropicToken(futureCredentials);
    assert.deepEqual(delays, [1250, 30_000]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("refresh grace applies to network, 429, and 5xx failures but not permanent 4xx", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response("revoked", {
      status: 400,
      headers: { "x-should-retry": "false" },
    });
    await assert.rejects(
      refreshAnthropicToken(futureCredentials),
      /Token refresh failed:.*400 revoked/,
    );

    for (const status of [429, 503]) {
      globalThis.fetch = async () => new Response("temporary", {
        status,
        headers: { "x-should-retry": "false" },
      });
      const refreshed = await refreshAnthropicToken(futureCredentials);
      assert.equal(refreshed.access, futureCredentials.access);
      assert.equal(refreshed.refresh, futureCredentials.refresh);
      assert.ok(refreshed.expires > Date.now());
    }

    globalThis.fetch = async () => {
      throw new TypeError("network unavailable");
    };
    const refreshed = await refreshAnthropicToken(futureCredentials);
    assert.equal(refreshed.access, futureCredentials.access);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
