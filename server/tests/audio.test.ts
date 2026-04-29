import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";
import { SttUnavailableError } from "../src/stt";

const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

describe("POST /api/audio", () => {
  it("transcribes PCM and forwards the text to the selected slot", async () => {
    const transcribePcm = vi.fn(async () => "進捗を教えて");
    const sendText = vi.fn();
    const app = createApp({ token: "secret", sendText, transcribePcm, rateLimitWindowMs: 0 });

    const response = await app.request("/api/audio?slot=beta&requestId=voice-1", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/octet-stream",
        "x-forwarded-for": "127.0.0.1",
      },
      body: pcm,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      slot: "beta",
      transcribed: "進捗を教えて",
      requestId: "voice-1",
    });
    expect(transcribePcm).toHaveBeenCalledWith(Buffer.from(pcm));
    expect(sendText).toHaveBeenCalledWith("beta", "進捗を教えて");
  });

  it("returns STT_UNAVAILABLE without sending text when no provider exists", async () => {
    const sendText = vi.fn();
    const app = createApp({
      token: "secret",
      sendText,
      transcribePcm: vi.fn(async () => {
        throw new SttUnavailableError();
      }),
    });

    const response = await app.request("/api/audio?slot=cc", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/octet-stream",
        "x-forwarded-for": "127.0.0.1",
      },
      body: pcm,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "STT_UNAVAILABLE" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("rejects PCM bodies longer than 30 seconds", async () => {
    const app = createApp({
      token: "secret",
      sendText: vi.fn(),
      transcribePcm: vi.fn(),
      maxAudioBytes: 4,
    });

    const response = await app.request("/api/audio?slot=cc", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/octet-stream",
        "x-forwarded-for": "127.0.0.1",
      },
      body: pcm,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: "AUDIO_TOO_LARGE" });
  });
});
