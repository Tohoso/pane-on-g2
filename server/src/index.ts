import { createServer, type IncomingMessage } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { Slot } from "@pane-on-g2/shared/protocol";
import {
  sendText as providerSendText,
  sendInterrupt as providerSendInterrupt,
} from "./adapters.ts";
import { getConfiguredToken, type AuthConfig } from "./auth.ts";
import { createAudioHandler } from "./audio.ts";
import { applyProviderEnv, loadAppConfig, type AppConfig } from "./config.ts";
import { createInterruptHandler, type SendInterrupt } from "./interrupt.ts";
import { createPromptHandler, json, type SendText } from "./prompt.ts";
import { createEventPersistence, type EventPersistence } from "./persistence.ts";
import { transcribePcm as defaultTranscribePcm, type TranscribePcm } from "./stt.ts";
import { EventBroker, createSseHandler, startAllJsonlMirrors, startAllPanePollers } from "./stream.ts";

type Handler = (request: Request) => Response | Promise<Response>;
type Route = { method: string; path: string; handler: Handler };

export type AppDeps = AuthConfig & {
  config?: AppConfig;
  sendText?: SendText;
  sendInterrupt?: SendInterrupt;
  transcribePcm?: TranscribePcm;
  maxAudioBytes?: number;
  rateLimitWindowMs?: number;
  startTailer?: boolean;
  broker?: EventBroker;
  persistence?: EventPersistence;
};

export class MiniApp {
  private readonly routes: Route[] = [];
  private readonly cleanup: Array<() => void> = [];

  route(method: string, path: string, handler: Handler) {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  onClose(cleanup: () => void) {
    this.cleanup.push(cleanup);
  }

  close() {
    for (const cleanup of this.cleanup.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Best-effort app shutdown.
      }
    }
  }

  async request(path: string, init: RequestInit = {}) {
    const url = path.startsWith("http") ? path : `http://localhost${path}`;
    return this.fetch(new Request(url, init));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    const match = this.routes.find((route) => route.method === request.method && route.path === url.pathname);
    if (!match) return withCors(json({ ok: false, code: "NOT_FOUND", message: "Not found" }, 404));

    try {
      return withCors(await match.handler(request));
    } catch (error) {
      return withCors(json({
        ok: false,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Internal server error",
      }, 500));
    }
  }
}

export function createApp(deps: AppDeps = {}) {
  const config = deps.config || loadAppConfig();
  applyProviderEnv(config);
  const slots = config.slots;
  const app = new MiniApp();
  const broker = deps.broker || new EventBroker(500, deps.persistence);
  const auth = { ...deps, tokenFile: deps.tokenFile || config.tokenFile, token: getConfiguredToken({ ...deps, tokenFile: deps.tokenFile || config.tokenFile }) };
  const sendText: SendText = deps.sendText || ((slot: Slot, text: string) => providerSendText(slot, text));
  const sendInterrupt: SendInterrupt = deps.sendInterrupt || ((slot: Slot) => providerSendInterrupt(slot));
  const transcribePcm: TranscribePcm = deps.transcribePcm || defaultTranscribePcm;
  const promptHandler = createPromptHandler({ ...auth, sendText, slots, rateLimitWindowMs: deps.rateLimitWindowMs });
  const interruptHandler = createInterruptHandler({ ...auth, sendInterrupt, slots, rateLimitWindowMs: deps.rateLimitWindowMs });
  const audioHandler = createAudioHandler({
    ...auth,
    sendText,
    transcribePcm,
    slots,
    maxAudioBytes: deps.maxAudioBytes,
    rateLimitWindowMs: deps.rateLimitWindowMs,
  });
  const sseHandler = createSseHandler(broker, auth, slots);

  app.route("GET", "/health", () => json({ ok: true, slots }));
  app.route("GET", "/api/health", () => json({ ok: true, service: "pane-on-g2", slots }));
  app.route("GET", "/api/v1/health", () => json({ ok: true, service: "pane-on-g2", slots }));
  app.route("GET", "/api/slots", () => json({ ok: true, slots: getSlotStatuses(config) }));
  app.route("GET", "/api/v1/slots", () => json({ ok: true, slots: getSlotStatuses(config) }));
  app.route("POST", "/api/prompt", promptHandler);
  app.route("POST", "/api/v1/prompt", promptHandler);
  app.route("POST", "/api/audio", audioHandler);
  app.route("POST", "/api/v1/audio/transcribe", audioHandler);
  app.route("POST", "/api/interrupt", interruptHandler);
  app.route("POST", "/api/v1/interrupt", interruptHandler);
  app.route("GET", "/api/events", sseHandler);
  app.route("GET", "/api/v1/events", sseHandler);

  if (deps.startTailer) {
    const stopJsonlMirrors = startAllJsonlMirrors(broker, slots);
    const stopPanePollers = startAllPanePollers(broker, slots);
    app.onClose(() => {
      stopPanePollers();
      stopJsonlMirrors();
    });
  }
  return app;
}

function getSlotStatuses(config: AppConfig) {
  return config.slots.map((slot) => ({
    slot,
    id: `${config.label}:${slot}`,
    title: `Pane ${slot}`,
    alive: isTmuxSessionAlive(slot, config.tmuxPrefix),
  }));
}

function isTmuxSessionAlive(slot: Slot, prefix: string): boolean {
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.TMUX;
    delete cleanEnv.TMUX_PANE;
    execFileSync("tmux", ["-L", slot, "has-session", "-t", `${prefix}${slot}`], {
      stdio: "ignore",
      timeout: 3_000,
      env: cleanEnv,
    });
    return true;
  } catch {
    return false;
  }
}

export async function startServer(deps: AppDeps = {}) {
  const config = deps.config || loadAppConfig();
  applyProviderEnv(config);
  const persistence = deps.persistence || (deps.broker ? undefined : createEventPersistence());
  const broker = deps.broker || new EventBroker(500, persistence);
  const app = createApp({ ...deps, config, broker, persistence, startTailer: false });
  const port = config.port;
  const host = config.bind;
  const staticRoot = resolve(process.cwd(), "frontend/dist");
  const mirrorStops: Array<() => void> = [];
  let mirrorsStopped = false;
  const server = createServer(async (req, res) => {
    const request = await incomingToRequest(req);
    const startedAt = Date.now();
    const response = process.env.NODE_ENV === "production"
      ? (serveStaticAsset(request, staticRoot) || await app.fetch(request))
      : await app.fetch(request);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      console.log(
        `[${new Date().toISOString()}] ${request.method} ${url.pathname}${url.search} → ${response.status} (${Date.now() - startedAt}ms)`,
      );
    }

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  });

  server.listen(port, host, () => {
    console.log(`pane-on-g2 server listening on http://${host}:${port}`);
    if (deps.startTailer ?? true) {
      mirrorStops.push(startAllJsonlMirrors(broker, config.slots));
      mirrorStops.push(startAllPanePollers(broker, config.slots));
    }
  });
  server.on("close", () => {
    if (mirrorsStopped) return;
    mirrorsStopped = true;
    for (const stop of mirrorStops.splice(0).reverse()) {
      try {
        stop();
      } catch {
        // Best-effort server shutdown.
      }
    }
    app.close();
  });
  return server;
}

function serveStaticAsset(request: Request, root: string): Response | null {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname === "/health" || url.pathname.startsWith("/api/")) return null;
  if (!existsSync(root)) return null;

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const candidate = normalize(join(root, requested));
  const safeRoot = `${normalize(root)}/`;
  const path = candidate.startsWith(safeRoot) ? candidate : join(root, "index.html");
  const finalPath = existsSync(path) && statSync(path).isFile() ? path : join(root, "index.html");
  if (!existsSync(finalPath)) return null;

  const body = request.method === "HEAD" ? null : readFileSync(finalPath);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentTypeFor(finalPath),
      "cache-control": finalPath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type,last-event-id,x-pane-on-g2-device-id,x-forwarded-for,x-tailscale-user");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function incomingToRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "localhost";
  return new Request(`${protocol}://${host}${req.url || "/"}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
