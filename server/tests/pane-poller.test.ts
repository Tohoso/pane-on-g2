import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanePoller, sanitizeAnsi, trimCcChrome } from "../src/pane-poller";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("PanePoller", () => {
  it("polls capturePane every interval and emits unchanged content only once", async () => {
    const capturePane = vi.fn()
      .mockResolvedValueOnce("hello\n")
      .mockResolvedValueOnce("hello\n")
      .mockResolvedValueOnce("hello\nworld\n");
    const emitted: string[] = [];
    const poller = new PanePoller("cc", {
      intervalMs: 50,
      captureLines: 20,
      capturePane,
      onSnapshot: (_slot, content) => emitted.push(content),
    });

    poller.start();
    await advance(0);
    await advance(50);
    await advance(50);

    expect(capturePane).toHaveBeenCalledTimes(3);
    expect(capturePane).toHaveBeenCalledWith("cc", 20);
    expect(emitted).toEqual(["hello\n", "hello\nworld\n"]);
    poller.stop();
  });

  it("skips snapshots that match the previous emitted content verbatim", async () => {
    const capturePane = vi.fn()
      .mockResolvedValueOnce("same\n")
      .mockResolvedValueOnce("same\n");
    const emitted: string[] = [];
    const poller = new PanePoller("cc", {
      intervalMs: 10,
      capturePane,
      onSnapshot: (_slot, content) => emitted.push(content),
    });

    poller.start();
    await advance(0);
    await advance(10);

    expect(emitted).toEqual(["same\n"]);
    poller.stop();
  });

  it("drops in-flight captures after stop", async () => {
    let resolveCapture!: (value: string) => void;
    const capturePane = vi.fn(() => new Promise<string>((resolve) => { resolveCapture = resolve; }));
    const emitted: string[] = [];
    const poller = new PanePoller("cc", {
      intervalMs: 10,
      capturePane,
      onSnapshot: (_slot, content) => emitted.push(content),
    });

    poller.start();
    await advance(0);
    poller.stop();
    resolveCapture("late\n");
    await Promise.resolve();

    expect(emitted).toEqual([]);
  });
});

describe("trimCcChrome", () => {
  it("strips the input box and task list above it while preserving assistant text", () => {
    const lines = [
      "assistant line 1",
      "assistant line 2",
      "",
      "3 tasks (2 running, 1 pending)",
      "◼ Read server/src/stream.ts",
      "◻ Write tests",
      "⎿ tool output",
      "────────────────────────",
      "❯ user is typing",
      "────────────────────────",
      "status footer",
    ];

    expect(trimCcChrome(lines)).toEqual(["assistant line 1", "assistant line 2"]);
  });

  it("is a no-op when no input box anchor is present", () => {
    const lines = ["plain shell", "no prompt box"];

    expect(trimCcChrome(lines)).toEqual(lines);
  });
});

describe("sanitizeAnsi", () => {
  it("strips representative ANSI escapes and non-newline controls", () => {
    const raw = "a\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07b\x1b(Bc\x00\x08\n\n\nend";

    expect(sanitizeAnsi(raw)).toBe("ared\nbc\n\nend");
  });
});
