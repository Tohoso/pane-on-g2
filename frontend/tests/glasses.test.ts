import { describe, expect, it } from "vitest";
import { GlassesRenderer, cleanChunk, slidingUtf8Window, utf8ByteLength } from "../src/glasses";

describe("G2 text windowing", () => {
  it("keeps the last 240 Japanese chars without splitting UTF-8 bytes", () => {
    const text = "あ".repeat(300);
    const window = slidingUtf8Window(text);

    expect(Array.from(window)).toHaveLength(240);
    expect(utf8ByteLength(window)).toBe(720);
  });

  it("also caps ASCII to 240 visible chars", () => {
    const text = "x".repeat(300);
    expect(slidingUtf8Window(text)).toBe("x".repeat(240));
  });

  it("strips ANSI, OSC, spinner, and control characters", () => {
    const raw = "\u001b]0;title\u0007\u001b[32m●了解\u001b[0m\r\n\u0001";
    expect(cleanChunk(raw)).toBe("了解\n");
  });

  it("debounces textContainerUpgrade calls", async () => {
    const calls: unknown[] = [];
    const renderer = new GlassesRenderer({
      bridge: { textContainerUpgrade: async (payload: unknown) => calls.push(payload) },
      debounceMs: 10,
    });

    renderer.update({ slot: "cc", state: "busy", assistantText: "あ".repeat(10) });
    renderer.update({ slot: "cc", state: "busy", assistantText: "あ".repeat(20) });
    renderer.update({ slot: "cc", state: "busy", assistantText: "あ".repeat(30) });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(calls).toHaveLength(3);
    expect(calls.map((call: any) => call.containerName)).toEqual(["g2-header", "g2-body", "g2-footer"]);
    expect((calls[1] as any).content).toBe("あ".repeat(30));
  });

  it("renders three bordered containers on initialize", async () => {
    const startupCalls: unknown[] = [];
    const renderer = new GlassesRenderer({
      bridge: {
        createStartUpPageContainer: async (payload: unknown) => startupCalls.push(payload),
        textContainerUpgrade: async () => undefined,
      },
      debounceMs: 10,
    });

    await renderer.initialize({
      slot: "cc",
      state: "idle",
      assistantText: "hello",
      now: new Date("2026-04-28T10:00:00+09:00"),
    });

    expect(startupCalls).toHaveLength(1);
    const startup = startupCalls[0] as any;
    expect(startup.containerTotalNum).toBe(3);
    expect(startup.textObject).toHaveLength(3);
    expect(startup.textObject[0]).toMatchObject({
      containerName: "g2-header",
      borderWidth: 1,
      borderColor: 6,
    });
    expect(startup.textObject[1]).toMatchObject({
      containerName: "g2-body",
      borderWidth: 1,
      borderColor: 6,
      isEventCapture: 1,
    });
    expect(startup.textObject[2]).toMatchObject({
      containerName: "g2-footer",
      borderWidth: 1,
      borderColor: 6,
    });
  });
});
