import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export type AuthConfig = {
  token?: string;
  tokenFile?: string;
  requireTailscale?: boolean;
};

export type AuthResult =
  | { ok: true; ip: string }
  | { ok: false; status: 401 | 403; code: string; message: string };

export class MissingTokenError extends Error {
  readonly code = "MISSING_TOKEN";
  constructor() {
    super(
      "PANE_ON_G2_TOKEN is not configured. Set the env var or create .env.prod before starting the server.",
    );
    this.name = "MissingTokenError";
  }
}

export function getConfiguredToken(config: AuthConfig = {}): string {
  if (config.token) return config.token;
  if (process.env.PANE_ON_G2_TOKEN) return process.env.PANE_ON_G2_TOKEN;
  const tokenFile = config.tokenFile || process.env.PANE_ON_G2_TOKEN_FILE;
  if (tokenFile && existsSync(tokenFile)) return readFileSync(tokenFile, "utf8").trim();
  throw new MissingTokenError();
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export function extractClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    forwarded ||
    headers.get("x-real-ip") ||
    headers.get("cf-connecting-ip") ||
    headers.get("x-client-ip") ||
    "127.0.0.1"
  );
}

export function isTailscaleOrLocalIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("100.") ||
    normalized.toLowerCase().startsWith("fd7a:115c:a1e0:")
  );
}

export function authorizeRequest(request: Request, config: AuthConfig = {}): AuthResult {
  const expected = getConfiguredToken(config);
  const url = new URL(request.url);
  const header = request.headers.get("authorization") || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer || url.searchParams.get("token") || "";

  if (!supplied || !constantTimeEqual(supplied, expected)) {
    return { ok: false, status: 401, code: "UNAUTHORIZED", message: "Missing or invalid bearer token" };
  }

  const ip = extractClientIp(request.headers);
  const hasVerifiedTailnetHeader =
    request.headers.has("x-tailscale-user") ||
    request.headers.has("tailscale-user") ||
    request.headers.has("x-webauth-user");

  if (config.requireTailscale !== false && !hasVerifiedTailnetHeader && !isTailscaleOrLocalIp(ip)) {
    return { ok: false, status: 403, code: "FORBIDDEN_NETWORK", message: "Request is not from Tailscale or localhost" };
  }

  return { ok: true, ip };
}
