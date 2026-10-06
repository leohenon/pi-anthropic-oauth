import { createServer } from "node:http";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { makeClaudeCodeUserAgent } from "./version.js";

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
const USER_AGENT = makeClaudeCodeUserAgent();
const CALLBACK_PORT = 53692;
const CALLBACK_HOST = "127.0.0.1";
const LOCAL_CALLBACK_TIMEOUT = 5 * 60 * 1000;
const MAX_TOKEN_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 30_000;
const MANUAL_SETTLE_GRACE_MS = 10_000;
const LOCAL_REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

export { USER_AGENT };

class TokenHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TokenHttpError";
  }
}

function isTransientTokenError(error: unknown): boolean {
  if (error instanceof TokenHttpError) {
    return error.status === 429 ||
      (error.status >= 500 && error.status < 600);
  }
  return error instanceof TypeError;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_DELAY_MS);
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

type ParsedAuthInput = {
  code: string;
  state: string;
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
  const initiatedRedirectUris = new Set<string>();

  let localAuthorization: LocalAuthorization | null = null;
  try {
    localAuthorization = await createLocalAuthorization(state);
  } catch {
    // Failure to bind the callback server falls back to the paste flow.
  }

  try {
    if (localAuthorization) {
      const local = localAuthorization;
      redirectUri = local.redirectUri;
      initiatedRedirectUris.add(redirectUri);

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
          await Promise.race([manualPromise, settleGrace()]);
          if (manualError) throw manualError;
          if (manualInput) authInput = manualInput;
        }
      } else {
        authInput = await local.waitForCallback();
      }
    }
  } finally {
    localAuthorization?.cancel();
  }

  if (!authInput) {
    redirectUri = REDIRECT_URI;
    initiatedRedirectUris.add(redirectUri);
    callbacks.onAuth({
      url: makeAuthorizeUrl(challenge, state, redirectUri),
      instructions:
        "Sign in with Claude, then paste the full callback URL or the code#state value.",
    });
    authInput = await callbacks.onPrompt({
      message: "Paste the callback URL or code#state:",
    });
  }

  const parsed = parseAuthInput(authInput, initiatedRedirectUris);
  if (!parsed) throw new Error("Could not parse authorization callback input.");
  if (parsed.state !== state) throw new Error("OAuth state mismatch.");

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
      (response.status === 429 ||
        (response.status >= 500 && response.status < 600))
    ) {
      const delayMs =
        parseRetryAfter(response.headers.get("retry-after")) ??
        INITIAL_RETRY_DELAY_MS * 2 ** attempt;

      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      const url = new URL(req.url ?? "/", LOCAL_REDIRECT_URI);

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
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid state");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
      });
      res.end(makeCallbackPage());
      finish(`${LOCAL_REDIRECT_URI}?${url.searchParams.toString()}`);
    });

    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        finish(null);
        reject(error);
        return;
      }
      finish(null);
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      settled = true;
      timer = setTimeout(() => finish(null), LOCAL_CALLBACK_TIMEOUT);
      timer.unref?.();
      resolve({
        redirectUri: LOCAL_REDIRECT_URI,
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
  return new Promise((resolve) => setTimeout(resolve, MANUAL_SETTLE_GRACE_MS));
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

function parseAuthInput(
  input: string,
  initiatedRedirectUris: ReadonlySet<string>,
): ParsedAuthInput | null {
  const text = input.trim();

  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) {
      const redirectUri = `${url.origin}${url.pathname}`;
      if (!initiatedRedirectUris.has(redirectUri)) return null;
      return { code, state, redirectUri };
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
