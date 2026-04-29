import { describe, expect, it } from "vitest";
import { buildG2FlatText, createRenderSnapshot, windowAtOffset } from "../src/glasses";
import type { Turn } from "../src/types";

describe("G2 history transcript text", () => {
  it("returns empty text for an empty transcript and no assistant buffer", () => {
    expect(buildG2FlatText([], "")).toBe("");
  });

  it("joins completed user and assistant turns with separators", () => {
    const transcript: Turn[] = [
      { id: "u1", role: "user", text: "hi", source: "tmux", ts: 1 },
      { id: "a1", role: "assistant", text: "回答", status: "complete", ts: 2 },
    ];

    expect(buildG2FlatText(transcript, "")).toBe("> hi\n──\n回答");
  });

  it("prefixes every line of multi-line user turns", () => {
    const transcript: Turn[] = [
      { id: "u1", role: "user", text: "one\ntwo", source: "tmux", ts: 1 },
      { id: "a1", role: "assistant", text: "done", status: "complete", ts: 2 },
    ];

    expect(buildG2FlatText(transcript, "")).toBe("> one\n> two\n──\ndone");
  });

  it("uses the in-flight assistant buffer for a streaming placeholder", () => {
    const transcript: Turn[] = [
      { id: "u1", role: "user", text: "hi", source: "tmux", ts: 1 },
      { id: "a1", role: "assistant", text: "", status: "streaming", ts: 2 },
    ];

    expect(buildG2FlatText(transcript, "部分応答...")).toBe("> hi\n──\n部分応答...");
  });
});

describe("G2 offset windowing", () => {
  it("returns the last max chars when offset is zero", () => {
    expect(windowAtOffset("x".repeat(300), 0)).toBe("x".repeat(240));
  });

  it("shifts the window back by the requested character offset", () => {
    const text = Array.from({ length: 300 }, (_, index) => String(index % 10)).join("");

    expect(windowAtOffset(text, 20, 10)).toBe(text.slice(270, 280));
  });

  it("clamps negative offsets to live mode", () => {
    expect(windowAtOffset("abcdef", -10, 3)).toBe("def");
  });

  it("clamps offsets past the start to the first available window", () => {
    expect(windowAtOffset("abcdef", 999, 3)).toBe("abc");
  });

  it("does not split UTF-8 characters when byte-limited", () => {
    const window = windowAtOffset("あ".repeat(300), 0);

    expect(Array.from(window)).toHaveLength(240);
  });
});

describe("G2 history header indicator", () => {
  it("appends the history offset when scrolled back", () => {
    const snapshot = createRenderSnapshot({
      slot: "cc",
      state: "busy",
      assistantText: "hello",
      historyOffset: 160,
      now: new Date("2026-04-28T13:42:00+09:00"),
    });

    expect(snapshot.header).toBe("g2:cc *BUSY* 13:42 ↑160");
  });

  it("omits the history offset when live or undefined", () => {
    const live = createRenderSnapshot({
      slot: "cc",
      state: "idle",
      assistantText: "hello",
      historyOffset: 0,
      now: new Date("2026-04-28T13:42:00+09:00"),
    });
    const implicit = createRenderSnapshot({
      slot: "cc",
      state: "idle",
      assistantText: "hello",
      now: new Date("2026-04-28T13:42:00+09:00"),
    });

    expect(live.header).toBe("g2:cc idle 13:42");
    expect(implicit.header).toBe("g2:cc idle 13:42");
  });
});
