import { randomUUID } from "node:crypto";
import type { Slot } from "@pane-on-g2/shared/protocol";
import { SLOTS, isSlot } from "@pane-on-g2/shared/protocol";
import { authorizeRequest, extractClientIp, type AuthConfig } from "./auth.ts";
import { createIpRateLimiter, json, type SendText } from "./prompt.ts";
import { SttUnavailableError, type TranscribePcm } from "./stt.ts";

const PCM_16K_MONO_S16LE_BYTES_PER_SECOND = 16_000 * 2;
export const DEFAULT_MAX_AUDIO_BYTES = PCM_16K_MONO_S16LE_BYTES_PER_SECOND * 30;

export type AudioDeps = AuthConfig & {
  sendText: SendText;
  transcribePcm: TranscribePcm;
  slots?: readonly Slot[];
  maxAudioBytes?: number;
  rateLimitWindowMs?: number;
};

export function createAudioHandler(deps: AudioDeps) {
  const limiter = createIpRateLimiter(deps.rateLimitWindowMs ?? 500);

  return async function handleAudio(request: Request): Promise<Response> {
    const auth = authorizeRequest(request, deps);
    if (!auth.ok) return json({ ok: false, code: auth.code, message: auth.message }, auth.status);

    const ip = extractClientIp(request.headers);
    const limited = limiter.consume(ip);
    if (!limited.ok) {
      return json(
        { ok: false, code: "RATE_LIMITED", message: "Too many audio requests", retryAfterMs: limited.retryAfterMs },
        429,
      );
    }

    const url = new URL(request.url);
    const slot = url.searchParams.get("slot") || "cc";
    const slots = deps.slots || SLOTS;
    if (!isSlot(slot, slots)) {
      return json({ ok: false, code: "BAD_SLOT", message: `slot must be one of: ${slots.join(", ")}` }, 400);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/octet-stream")) {
      return json({ ok: false, code: "BAD_CONTENT_TYPE", message: "audio must be application/octet-stream PCM" }, 415);
    }

    const buffer = Buffer.from(await request.arrayBuffer());
    const maxBytes = deps.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (buffer.length > maxBytes) {
      return json({ ok: false, code: "AUDIO_TOO_LARGE", message: "audio must be 30 seconds or less" }, 413);
    }
    if (buffer.length === 0) return json({ ok: false, code: "EMPTY_AUDIO", message: "audio body is empty" }, 400);

    let transcribed: string;
    try {
      transcribed = (await deps.transcribePcm(buffer)).trim();
    } catch (error) {
      if (error instanceof SttUnavailableError || (error as { code?: string })?.code === "STT_UNAVAILABLE") {
        return json({ ok: false, code: "STT_UNAVAILABLE", message: "No local Whisper provider is available" }, 503);
      }
      return json(
        { ok: false, code: "STT_FAILED", message: error instanceof Error ? error.message : "STT failed" },
        502,
      );
    }

    if (!transcribed) return json({ ok: false, code: "EMPTY_TRANSCRIPT", message: "Whisper returned no text" }, 422);

    const requestId = url.searchParams.get("requestId") || randomUUID();
    try {
      await deps.sendText(slot, transcribed);
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

    return json({ ok: true, slot, transcribed, requestId }, 200);
  };
}
