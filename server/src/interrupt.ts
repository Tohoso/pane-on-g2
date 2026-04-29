import type { Slot, InterruptRequest } from "@pane-on-g2/shared/protocol";
import { SLOTS, isSlot } from "@pane-on-g2/shared/protocol";
import { authorizeRequest, extractClientIp, type AuthConfig } from "./auth.ts";
import { createIpRateLimiter, json } from "./prompt.ts";

export type SendInterrupt = (slot: Slot) => void | Promise<void>;

export type InterruptDeps = AuthConfig & {
  sendInterrupt: SendInterrupt;
  slots?: readonly Slot[];
  rateLimitWindowMs?: number;
};

export function validateInterruptRequest(
  value: unknown,
  slots: readonly Slot[] = SLOTS,
): InterruptRequest | { ok: false; code: string; message: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, code: "BAD_JSON", message: "Request body must be a JSON object" };
  }

  const body = value as Partial<InterruptRequest>;
  if (!isSlot(body.slot, slots)) {
    return { ok: false, code: "BAD_SLOT", message: `slot must be one of: ${slots.join(", ")}` };
  }

  return { slot: body.slot };
}

export function createInterruptHandler(deps: InterruptDeps) {
  const limiter = createIpRateLimiter(deps.rateLimitWindowMs ?? 500);

  return async function handleInterrupt(request: Request): Promise<Response> {
    const auth = authorizeRequest(request, deps);
    if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);

    const ip = extractClientIp(request.headers);
    const limited = limiter.consume(ip);
    if (!limited.ok) {
      return json(
        { ok: false, code: "RATE_LIMITED", message: "Too many interrupt requests", retryAfterMs: limited.retryAfterMs },
        429,
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      return json({ ok: false, code: "BAD_JSON", message: "Invalid JSON body" }, 400);
    }

    const interrupt = validateInterruptRequest(parsedBody, deps.slots);
    if ("ok" in interrupt && interrupt.ok === false) return json(interrupt, 400);

    try {
      await deps.sendInterrupt(interrupt.slot);
    } catch (error) {
      return json(
        {
          ok: false,
          code: "TMUX_INTERRUPT_FAILED",
          message: error instanceof Error ? error.message : "Failed to interrupt tmux",
        },
        502,
      );
    }

    return json({ ok: true, slot: interrupt.slot, interruptedAt: Date.now() }, 200);
  };
}
