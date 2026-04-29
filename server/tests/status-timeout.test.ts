import { describe, expect, it, vi } from "vitest";
import { BusyStatusTracker } from "../src/status";

describe("BusyStatusTracker", () => {
  it("soft-idles after no JSONL update for the timeout window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: unknown[] = [];
    const tracker = new BusyStatusTracker({
      slot: "cc",
      timeoutMs: 60_000,
      emit: (event) => events.push(event),
      now: Date.now,
    });

    tracker.markBusy();
    expect(events).toEqual([{ type: "status", slot: "cc", state: "busy", ts: 1_000 }]);

    vi.advanceTimersByTime(60_000);
    expect(events.at(-1)).toMatchObject({
      type: "status",
      slot: "cc",
      state: "idle",
      message: "No JSONL update for 60s; soft idle",
    });

    tracker.stop();
    vi.useRealTimers();
  });
});
