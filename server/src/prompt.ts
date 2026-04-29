import type { Slot, PromptRequest, PromptResponse } from "@pane-on-g2/shared/protocol";
import { SLOTS, isSlot } from "@pane-on-g2/shared/protocol";
import { authorizeRequest, extractClientIp, type AuthConfig } from "./auth.ts";

export type SendText = (slot: Slot, text: string) => void | Promise<void>;

export type PromptDeps = AuthConfig & {
  sendText: SendText;
  slots?: readonly Slot[];
  rateLimitWindowMs?: number;
};

type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

export function createIpRateLimiter(windowMs = 2_000) {
  const lastByIp = new Map<string, number>();

  return {
    consume(ip: string, now = Date.now()): RateLimitResult {
      const last = lastByIp.get(ip) ?? 0;
      const elapsed = now - last;
      if (elapsed < windowMs) return { ok: false, retryAfterMs: windowMs - elapsed };
      lastByIp.set(ip, now);
      return { ok: true };
    },
    clear() {
      lastByIp.clear();
    },
  };
}

export function validatePromptRequest(value: unknown, slots: readonly Slot[] = SLOTS): PromptRequest | PromptResponse {
  if (!value || typeof value !== "object") {
    return { ok: false, code: "BAD_JSON", message: "Request body must be a JSON object" };
  }
  const body = value as Partial<PromptRequest>;
  if (!isSlot(body.slot, slots)) return { ok: false, code: "BAD_SLOT", message: `slot must be one of: ${slots.join(", ")}` };
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return { ok: false, code: "BAD_TEXT", message: "text is required" };
  }
  if (body.text.length > 4_000) return { ok: false, code: "TEXT_TOO_LONG", message: "text must be 4000 chars or less" };
  if (body.source !== "g2_text" && body.source !== "g2_voice" && body.source !== "ring_quick_reply") {
    return { ok: false, code: "BAD_SOURCE", message: "source is invalid" };
  }
  if (typeof body.requestId !== "string" || body.requestId.trim().length === 0) {
    return { ok: false, code: "BAD_REQUEST_ID", message: "requestId is required" };
  }
  return {
    slot: body.slot,
    text: body.text.trim(),
    source: body.source,
    requestId: body.requestId.trim(),
  };
}

export function createPromptHandler(deps: PromptDeps) {
  const limiter = createIpRateLimiter(deps.rateLimitWindowMs ?? 2_000);

  return async function handlePrompt(request: Request): Promise<Response> {
    const auth = authorizeRequest(request, deps);
    if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);

    const ip = extractClientIp(request.headers);
    const limited = limiter.consume(ip);
    if (!limited.ok) {
      return json(
        { ok: false, code: "RATE_LIMITED", message: "Too many prompt requests" },
        429,
        { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) },
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return json({ ok: false, code: "BAD_JSON", message: "Invalid JSON body" }, 400);
    }

    const prompt = validatePromptRequest(parsedBody, deps.slots);
    if ("ok" in prompt && prompt.ok === false) return json(prompt, 400);

    try {
      await deps.sendText(prompt.slot, prompt.text);
    } catch (error) {
      return json(
        {
          ok: false,
          code: "TMUX_SEND_FAILED",
          message: error instanceof Error ? error.message : "Failed to send text to tmux",
        },
        502,
      );
    }

    return json({ ok: true, slot: prompt.slot, requestId: prompt.requestId, acceptedAt: Date.now() }, 200);
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
