import { createServer } from "node:http";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");
const USER_AGENT = "claude-code/2.1.97";
const CALLBACK_PORT = 53692;
const CALLBACK_HOST = "127.0.0.1";
const LOCAL_CALLBACK_TIMEOUT = 5 * 60 * 1000;
const MAX_TOKEN_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 5000;

export { USER_AGENT };

const MAX_RETRY_DELAY_MS = 30_000;
const MANUAL_SETTLE_GRACE_MS = 10_000;

class TokenHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TokenHttpError";
  }
}

// Only network blips and server-side faults deserve the grace window on refresh.
// A 400 invalid_grant (revoked session, rotated refresh token) never recovers.
function isTransientTokenError(error: unknown): boolean {
  if (error instanceof TokenHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_DELAY_MS);
  }
  // RFC 9110 also allows an HTTP-date, which Number() turns into NaN - and
  // setTimeout(NaN) fires immediately, hammering a server that just asked to
  // be backed off.
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

type ParsedAuthInput = {
  code: string;
  state: string;
  // Origin+path the code was actually issued against, when the user pasted a
  // full callback URL. The token exchange must echo the same redirect_uri.
  redirectUri?: string;
};
type LocalAuthorization = {
  redirectUri: string;
  waitForCallback: () => Promise<string | null>;
  cancel: () => void;
};

export function isClaudeOAuthAccessToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

export async function loginAnthropic(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID().replace(/-/g, "");

  let authInput: string | null = null;
  let redirectUri = REDIRECT_URI;

  // Only failure to *start* the local server is a reason to fall back to the
  // manual paste flow. Everything after this point is a real error and must
  // propagate - the old blanket catch swallowed cancellations and aborts too,
  // which made the whole manualError path below dead code.
  let localAuthorization: LocalAuthorization | null = null;
  try {
    localAuthorization = await createLocalAuthorization(state);
  } catch {
    localAuthorization = null;
  }

  try {
    if (localAuthorization) {
      const local = localAuthorization;
      redirectUri = local.redirectUri;

      callbacks.onAuth({
        url: makeAuthorizeUrl(challenge, state, redirectUri),
        instructions:
          "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
      });

      if (callbacks.onManualCodeInput) {
        let manualInput: string | undefined;
        let manualError: Error | undefined;
        const manualPromise = callbacks
          .onManualCodeInput()
          .then((input) => {
            manualInput = input;
            local.cancel();
          })
          .catch((err) => {
            manualError =
              err instanceof Error ? err : new Error(String(err));
            local.cancel();
          });

        const callbackResult = await local.waitForCallback();

        if (manualError) throw manualError;

        if (callbackResult) {
          authInput = callbackResult;
        } else if (manualInput) {
          authInput = manualInput;
        }

        if (!authInput) {
          // The local callback timed out while the paste prompt is still open.
          // Give it a moment to settle, but never block login forever on a
          // prompt the user may have walked away from.
          await Promise.race([manualPromise, settleGrace()]);
          if (manualError) throw manualError;
          if (manualInput) authInput = manualInput;
        }
      } else {
        authInput = await local.waitForCallback();
      }
    }
  } finally {
    // Without this the HTTP server keeps listening and the 5-minute timer stays
    // armed on every failure path: the process cannot exit, port 53692 stays
    // bound, and a retried /login hits EADDRINUSE for the rest of the session.
    localAuthorization?.cancel();
  }

  if (!authInput) {
    callbacks.onAuth({
      url: makeAuthorizeUrl(challenge, state, REDIRECT_URI),
      instructions:
        "Sign in with Claude, then paste the full callback URL or the code#state value.",
    });
    authInput = await callbacks.onPrompt({
      message: "Paste the callback URL or code#state:",
    });
    redirectUri = REDIRECT_URI;
  }

  const parsed = parseAuthInput(authInput);
  if (!parsed) throw new Error("Could not parse authorization callback input.");
  if (parsed.state !== state) throw new Error("OAuth state mismatch.");

  // A user who completed the browser flow against the localhost URL before the
  // fallback appeared holds a code issued for that redirect_uri; exchanging it
  // under the default one fails with invalid_grant. Trust the pasted URL.
  const exchangeRedirectUri = parsed.redirectUri ?? redirectUri;

  const tokenResponse = await fetchWithRetry(
    TOKEN_URL,
    {
      method: "POST",
      headers: makeTokenHeaders(),
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: parsed.code,
        state: parsed.state,
        redirect_uri: exchangeRedirectUri,
        code_verifier: verifier,
      }),
      signal: callbacks.signal,
    },
    "Token exchange",
  );

  const data = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export async function refreshAnthropicToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      TOKEN_URL,
      {
        method: "POST",
        headers: makeTokenHeaders(),
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: credentials.refresh,
        }),
      },
      "Token refresh",
    );
  } catch (error) {
    // A permanently rejected refresh token must surface so the user is asked to
    // log in again. Extending the grace window on it produces an endless
    // 30-second retry loop against a credential that will never work.
    if (isTransientTokenError(error) && credentials.expires > Date.now()) {
      return { ...credentials, expires: Date.now() + 30_000 };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Token refresh failed: ${detail}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token || credentials.refresh,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

function makeAuthorizeUrl(
  challenge: string,
  state: string,
  redirectUri: string,
): string {
  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  return `${AUTHORIZE_URL}?${authParams.toString()}`;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_TOKEN_RETRIES; attempt++) {
    const response = await fetch(url, init);

    if (response.ok) return response;

    const bodyText = await response.text();

    const failure = new TokenHttpError(
      `${label} failed: ${response.status} ${bodyText}`,
      response.status,
    );

    const shouldRetry = response.headers.get("x-should-retry");
    if (shouldRetry === "false") throw failure;

    if (
      attempt < MAX_TOKEN_RETRIES &&
      (response.status === 429 || response.status >= 500)
    ) {
      const delayMs =
        parseRetryAfter(response.headers.get("retry-after")) ??
        INITIAL_RETRY_DELAY_MS * 2 ** attempt;

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
      lastError = failure;
      continue;
    }

    throw failure;
  }

  throw lastError ?? new Error(`${label} failed after retries`);
}

function makeTokenHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
  };
}

async function createLocalAuthorization(
  state: string,
): Promise<LocalAuthorization> {
  const server = createServer();

  return new Promise((resolve, reject) => {
    let done = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete!: (value: string | null) => void;
    const wait = new Promise<string | null>((innerResolve) => {
      complete = innerResolve;
    });

    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      complete(value);
      if (server.listening) {
        server.closeAllConnections();
        server.close();
      }
    };

    server.on("request", (req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      if (!code || !gotState) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing code or state");
        return;
      }

      if (gotState !== state) {
        // Reject the request but keep waiting. Aborting here let any local
        // process - or any page in the user's browser, since this is a plain
        // unauthenticated GET - cancel a login in flight with one bogus state.
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid state");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
      });
      res.end(makeCallbackPage());
      finish(url.toString());
    });

    // `once` would both hide every post-listen error (the promise is already
    // settled, so reject is a no-op) and consume the only handler - leaving a
    // second 'error' event to crash the host Pi process as an unhandled event.
    server.on("error", (error) => {
      if (done || settled) {
        finish(null);
        return;
      }
      settled = true;
      reject(error);
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      settled = true;
      timer = setTimeout(() => finish(null), LOCAL_CALLBACK_TIMEOUT);
      // Never hold the event loop open on a login the user has abandoned.
      timer.unref?.();
      resolve({
        redirectUri: `http://localhost:${CALLBACK_PORT}/callback`,
        waitForCallback: () => wait,
        cancel: () => finish(null),
      });
    });
  });
}

function makeCallbackPage(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Authorization complete</title></head>
  <body>
    <h1>Authorization complete</h1>
    <p>You can close this window and return to Pi.</p>
  </body>
</html>`;
}

function settleGrace(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, MANUAL_SETTLE_GRACE_MS);
    timer.unref?.();
  });
}

async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = toBase64Url(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return {
    verifier,
    challenge: toBase64Url(new Uint8Array(digest)),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseAuthInput(input: string): ParsedAuthInput | null {
  const text = input.trim();

  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) {
      return { code, state, redirectUri: `${url.origin}${url.pathname}` };
    }
  } catch {}

  const split = text.split("#");
  if (split.length === 2 && split[0] && split[1]) {
    return { code: split[0], state: split[1] };
  }

  const params = new URLSearchParams(text);
  const code = params.get("code");
  const state = params.get("state");
  return code && state ? { code, state } : null;
}
