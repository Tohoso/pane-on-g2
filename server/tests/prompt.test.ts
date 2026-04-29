import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";

describe("POST /api/prompt", () => {
  it("rejects missing bearer auth", async () => {
    const app = createApp({ token: "secret", sendText: vi.fn() });

    const response = await app.request("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify({ slot: "cc", text: "hi", source: "g2_text", requestId: "req_1" }),
    });

    expect(response.status).toBe(401);
  });

  it("validates input and sends accepted text to tmux", async () => {
    const sendText = vi.fn();
    const app = createApp({ token: "secret", sendText, rateLimitWindowMs: 2_000 });

    const response = await app.request("/api/prompt", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ slot: "cc", text: "G2 test", source: "g2_text", requestId: "req_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, slot: "cc", requestId: "req_1" });
    expect(sendText).toHaveBeenCalledWith("cc", "G2 test");
  });

  it("rate limits prompt posts per IP", async () => {
    const app = createApp({ token: "secret", sendText: vi.fn(), rateLimitWindowMs: 2_000 });
    const request = () =>
      app.request("/api/prompt", {
        method: "POST",
        headers: {
          "authorization": "Bearer secret",
          "content-type": "application/json",
          "x-forwarded-for": "100.64.0.8",
        },
        body: JSON.stringify({ slot: "cc", text: "again", source: "g2_text", requestId: crypto.randomUUID() }),
      });

    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });
});
