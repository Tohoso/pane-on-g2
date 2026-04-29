import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index";

describe("POST /api/interrupt", () => {
  it("sends Ctrl-C to the requested slot", async () => {
    const sendInterrupt = vi.fn();
    const app = createApp({ token: "secret", sendInterrupt });

    const response = await app.request("/api/interrupt", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ slot: "gamma" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, slot: "gamma" });
    expect(sendInterrupt).toHaveBeenCalledWith("gamma");
  });

  it("rejects unknown slots", async () => {
    const sendInterrupt = vi.fn();
    const app = createApp({ token: "secret", sendInterrupt });

    const response = await app.request("/api/interrupt", {
      method: "POST",
      headers: {
        "authorization": "Bearer secret",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ slot: "delta" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "BAD_SLOT" });
    expect(sendInterrupt).not.toHaveBeenCalled();
  });

  it("preserves auth on interrupt", async () => {
    const app = createApp({ token: "secret", sendInterrupt: vi.fn() });

    const response = await app.request("/api/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
      body: JSON.stringify({ slot: "cc" }),
    });

    expect(response.status).toBe(401);
  });
});
