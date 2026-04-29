import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";
import { EventBroker } from "../src/stream";

async function readFirstChunk(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return new TextDecoder().decode(value);
}

describe("multi-slot routing", () => {
  it("accepts prompts for the default slots", async () => {
    const sendText = vi.fn();
    const app = createApp({ token: "secret", sendText, rateLimitWindowMs: 0 });

    const response = await app.request("/api/prompt", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ slot: "alpha", text: "alpha ping", source: "g2_text", requestId: "req-alpha" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, slot: "alpha", requestId: "req-alpha" });
    expect(sendText).toHaveBeenCalledWith("alpha", "alpha ping");
  });

  it("accepts prompts for configured custom slots", async () => {
    const sendText = vi.fn();
    const app = createApp({
      token: "secret",
      sendText,
      rateLimitWindowMs: 0,
      config: {
        label: "lens",
        slots: ["main", "worker"],
        tmuxPrefix: "",
        ringReplies: {
          single_tap: { text: "ack", action: "prompt" },
          double_tap: { text: "progress?", action: "prompt" },
          long_press: { text: "interrupt", action: "interrupt" },
          triple_tap: { text: "be terse", action: "prompt" },
        },
        bind: "127.0.0.1",
        port: 3457,
      },
    });

    const response = await app.request("/api/prompt", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ slot: "worker", text: "ping", source: "g2_text", requestId: "req-worker" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, slot: "worker", requestId: "req-worker" });
    expect(sendText).toHaveBeenCalledWith("worker", "ping");
  });

  it("filters SSE replay by the subscribed slot", async () => {
    const broker = new EventBroker();
    broker.publish({ type: "text_delta", slot: "cc", text: "cc-only", seq: 1, turnId: "cc-1", ts: 1 });
    broker.publish({ type: "text_delta", slot: "alpha", text: "alpha-only", seq: 1, turnId: "alpha-1", ts: 2 });
    const app = createApp({ token: "secret", broker });

    const response = await app.request("/api/events?slot=alpha&cursor=000000000000", {
      headers: { "authorization": "Bearer secret", "x-forwarded-for": "127.0.0.1" },
      signal: AbortSignal.timeout(500),
    });

    expect(response.status).toBe(200);
    const chunk = await readFirstChunk(response);
    expect(chunk).toContain("alpha-only");
    expect(chunk).not.toContain("cc-only");
  });

  it("rejects SSE subscriptions for unknown slots", async () => {
    const app = createApp({ token: "secret", broker: new EventBroker() });

    const response = await app.request("/api/events?slot=delta", {
      headers: { "authorization": "Bearer secret", "x-forwarded-for": "127.0.0.1" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "BAD_SLOT" });
  });
});
