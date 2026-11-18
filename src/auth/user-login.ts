/**
 * Per-user SSO sign-in for SAP Analytics Cloud.
 *
 * Uses the OAuth 2.0 Authorization Code Grant (3-legged OAuth), so every
 * API call runs as the signed-in person, with that person's SAC
 * permissions, instead of as a shared technical user.
 *
 *   1. Open the tenant Authorization URL in the user's browser.
 *      The tenant redirects to the corporate IdP, where the user signs
 *      in with SSO and approves access.
 *   2. The tenant redirects back to a local loopback listener
 *      (SAC_REDIRECT_URI) with an authorization code.
 *   3. Exchange the code at the Token URL. The OAuth client is
 *      confidential, so the Client ID and Secret go in a Basic header.
 *   4. Store the access + refresh token in the user's home directory
 *      and refresh silently until the refresh token expires.
 *
 * SAC side: System > Administration > App Integration > Add a New OAuth
 * Client, Authorization Grant = "Authorization Code", Redirect URI =
 * SAC_REDIRECT_URI. The Authorization URL and Token URL are listed on
 * the same page.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OAuthConfig {
  tokenUrl: string;
  authorizeUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Thrown when no usable token exists. A browser sign-in has been started. */
export class SignInRequiredError extends Error {}

/** The token endpoint rejected the request (4xx): the grant is no longer valid. */
class TokenRejectedError extends Error {}

// ── Token store (one file per tenant + client, in the user's home) ──

function tokenDir(): string {
  return join(homedir(), ".sac-mcp");
}

function tokenFile(cfg: OAuthConfig): string {
  const key = createHash("sha256")
    .update(`${cfg.tokenUrl}|${cfg.clientId}`)
    .digest("hex")
    .slice(0, 16);
  return join(tokenDir(), `tokens-${key}.json`);
}

function readTokens(cfg: OAuthConfig): StoredTokens | null {
  try {
    return JSON.parse(readFileSync(tokenFile(cfg), "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

function writeTokens(cfg: OAuthConfig, tokens: StoredTokens): void {
  mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(cfg), JSON.stringify(tokens), { mode: 0o600 });
}

let memTokens: StoredTokens | null = null;

/**
 * Increments whenever the signed-in identity can change (sign-in, sign-out).
 * The HTTP client compares it to drop CSRF tokens and cookies of a previous user.
 */
export let identityGeneration = 0;

/** Forget the user's tokens, in memory and on disk. */
export function signOut(cfg: OAuthConfig): void {
  memTokens = null;
  rmSync(tokenFile(cfg), { force: true });
  identityGeneration++;
}

// ── Token endpoint ─────────────────────────────────────────────────

async function tokenRequest(
  cfg: OAuthConfig,
  params: Record<string, string>,
): Promise<StoredTokens> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const msg = `Token request failed (${res.status}): ${await res.text()}`;
    throw res.status >= 400 && res.status < 500 ? new TokenRejectedError(msg) : new Error(msg);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

// ── Browser sign-in ────────────────────────────────────────────────

let pendingLogin: { url: string; done: Promise<StoredTokens> } | null = null;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function openBrowser(url: string): void {
  // rundll32 keeps "&" in the URL intact; "cmd /c start" would split on it.
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  } catch {
    // The URL is always reported back, so the user can open it by hand.
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font-family:system-ui;margin:3rem"><h2>${title}</h2><p>${body}</p></body>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Start a browser SSO sign-in, or return the one already in progress.
 * `done` resolves when the user finishes signing in.
 */
export async function startSignIn(
  cfg: OAuthConfig,
): Promise<{ url: string; done: Promise<StoredTokens> }> {
  if (pendingLogin) return pendingLogin;

  const redirect = new URL(cfg.redirectUri);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)) {
    throw new Error(
      `SAC_REDIRECT_URI must point at this machine (localhost), got ${cfg.redirectUri}`,
    );
  }
  const port = Number(redirect.port || 80);

  const state = base64url(randomBytes(16));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", cfg.redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  let finish!: (r: StoredTokens | Error) => void;
  const result = new Promise<StoredTokens | Error>((r) => (finish = r));

  const handler: Parameters<typeof createServer>[1] = async (req, res) => {
    const url = new URL(req.url ?? "/", cfg.redirectUri);
    if (url.pathname !== redirect.pathname) {
      res.writeHead(404).end();
      return;
    }
    const fail = (msg: string) => {
      res.writeHead(400, { "Content-Type": "text/html" })
        .end(page("SAC sign-in failed", escapeHtml(msg)));
      finish(new Error(`SAC sign-in failed: ${msg}`));
    };
    if (url.searchParams.get("state") !== state) {
      return fail("State mismatch. Start sign-in again.");
    }
    const err = url.searchParams.get("error");
    if (err) return fail(`${err}: ${url.searchParams.get("error_description") ?? ""}`);
    const code = url.searchParams.get("code");
    if (!code) return fail("No authorization code returned.");
    try {
      const tokens = await tokenRequest(cfg, {
        grant_type: "authorization_code",
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: verifier,
      });
      res.writeHead(200, { "Content-Type": "text/html" })
        .end(page("Signed in to SAP Analytics Cloud", "You can close this tab."));
      finish(tokens);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  // The browser may resolve "localhost" to IPv4 or IPv6: listen on both,
  // and only on loopback.
  const hosts =
    redirect.hostname === "localhost"
      ? ["127.0.0.1", "::1"]
      : [redirect.hostname.replace(/[[\]]/g, "")];
  const servers: Server[] = [];
  let listenError: Error | null = null;
  for (const host of hosts) {
    const s = createServer(handler);
    try {
      await listen(s, port, host);
      servers.push(s);
    } catch (e) {
      listenError = e as Error;
    }
  }
  if (servers.length === 0) {
    throw new Error(
      `Cannot listen on ${cfg.redirectUri} for the sign-in callback: ${listenError?.message}`,
    );
  }

  const timer = setTimeout(
    () => finish(new Error("SAC sign-in timed out after 5 minutes.")),
    LOGIN_TIMEOUT_MS,
  );

  const done = result.then((r) => {
    clearTimeout(timer);
    for (const s of servers) s.close();
    pendingLogin = null;
    if (r instanceof Error) throw r;
    memTokens = r;
    writeTokens(cfg, r);
    identityGeneration++;
    return r;
  });
  done.catch(() => {}); // callers that only start the flow do not await it

  openBrowser(authUrl.toString());
  console.error(`[SAC] Sign in with SSO in your browser: ${authUrl}`);

  pendingLogin = { url: authUrl.toString(), done };
  return pendingLogin;
}

// ── Access token for API calls ─────────────────────────────────────

/**
 * Return a valid access token for the signed-in user.
 * Refreshes silently when possible. When the user must sign in, starts the
 * browser flow and throws SignInRequiredError (so a tool call never blocks
 * on a person typing a password).
 */
export async function getUserAccessToken(cfg: OAuthConfig): Promise<string> {
  memTokens ??= readTokens(cfg);

  if (memTokens && Date.now() < memTokens.expires_at - 60_000) {
    return memTokens.access_token;
  }

  if (memTokens?.refresh_token) {
    try {
      const refreshed = await tokenRequest(cfg, {
        grant_type: "refresh_token",
        refresh_token: memTokens.refresh_token,
      });
      refreshed.refresh_token ??= memTokens.refresh_token;
      memTokens = refreshed;
      writeTokens(cfg, refreshed);
      return refreshed.access_token;
    } catch (e) {
      // Network errors and 5xx keep the refresh token for the next try.
      if (!(e instanceof TokenRejectedError)) throw e;
      console.error(`[SAC] Refresh token rejected, sign-in required: ${e.message}`);
      signOut(cfg);
    }
  }

  const { url } = await startSignIn(cfg);
  throw new SignInRequiredError(
    "Not signed in to SAP Analytics Cloud. A browser window opened for SSO sign-in. " +
      "Finish signing in, then retry this request (or call sac_login to wait for it). " +
      `If no window opened, open this URL: ${url}`,
  );
}

/** Decode the user identity claims from a JWT access token (no verification). */
export function describeToken(accessToken: string): { user?: string; email?: string } {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"),
    ) as { user_name?: string; email?: string; sub?: string };
    return { user: payload.user_name ?? payload.sub, email: payload.email };
  } catch {
    return {};
  }
}
