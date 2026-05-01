import { describe, expect, it, vi } from "vitest";
import { bindTempleEvents, cycleSlot } from "../src/temple";

describe("Temple gestures", () => {
  it("cycleSlot cycles cc -> alpha -> beta -> gamma -> cc", () => {
    expect(cycleSlot("cc")).toBe("alpha");
    expect(cycleSlot("alpha")).toBe("beta");
    expect(cycleSlot("beta")).toBe("gamma");
    expect(cycleSlot("gamma")).toBe("cc");
  });

  it("bindTempleEvents defers onSingleTap on eventType 0 by 260ms (cancellable by double tap)", () => {
    vi.useFakeTimers();
    const handlers: Array<(event: unknown) => void> = [];
    const bridge = {
      onEvenHubEvent: vi.fn((handler: (event: unknown) => void) => {
        handlers.push(handler);
      }),
    };
    const onSingleTap = vi.fn();

    bindTempleEvents(bridge, { onSingleTap });
    handlers[0]({ textEvent: { eventType: 0 } });
    expect(onSingleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(260);
    expect(onSingleTap).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("bindTempleEvents cancels deferred single tap when double tap fires within window", () => {
    vi.useFakeTimers();
    const handlers: Array<(event: unknown) => void> = [];
    const bridge = {
      onEvenHubEvent: vi.fn((handler: (event: unknown) => void) => {
        handlers.push(handler);
      }),
    };
    const onSingleTap = vi.fn();
    const onDoubleTap = vi.fn();

    bindTempleEvents(bridge, { onSingleTap, onDoubleTap });
    handlers[0]({ textEvent: { eventType: 0 } });
    handlers[0]({ textEvent: { eventType: 3 } });
    vi.advanceTimersByTime(260);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onSingleTap).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("bindTempleEvents calls onScrollUp and onScrollDown on eventTypes 1 and 2", async () => {
    const handlers: Array<(event: unknown) => void> = [];
    const bridge = {
      onEvenHubEvent: vi.fn((handler: (event: unknown) => void) => {
        handlers.push(handler);
      }),
    };
    const onScrollUp = vi.fn();
    const onScrollDown = vi.fn();

    bindTempleEvents(bridge, { onScrollUp, onScrollDown });
    handlers[0]({ textEvent: { eventType: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 820));
    handlers[0]({ listEvent: { eventType: 2 } });

    expect(onScrollUp).toHaveBeenCalledTimes(1);
    expect(onScrollDown).toHaveBeenCalledTimes(1);
  });

  it("bindTempleEvents calls onDoubleTap on eventType 3", () => {
    const handlers: Array<(event: unknown) => void> = [];
    const bridge = {
      onEvenHubEvent: vi.fn((handler: (event: unknown) => void) => {
        handlers.push(handler);
      }),
    };
    const onDoubleTap = vi.fn();

    bindTempleEvents(bridge, { onDoubleTap });
    handlers[0]({ textEvent: { eventType: 3 } });

    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it("bindTempleEvents does not call handlers for empty payload or OS lifecycle sysEvent", () => {
    const handlers: Array<(event: unknown) => void> = [];
    const bridge = {
      onEvenHubEvent: vi.fn((handler: (event: unknown) => void) => {
        handlers.push(handler);
      }),
    };
    const onSingleTap = vi.fn();
    const onScrollUp = vi.fn();
    const onScrollDown = vi.fn();
    const onDoubleTap = vi.fn();

    bindTempleEvents(bridge, { onSingleTap, onScrollUp, onScrollDown, onDoubleTap });
    handlers[0]({});
    handlers[0]({ sysEvent: { eventType: 4 } });
    handlers[0]({ sysEvent: { eventType: 5 } });
    handlers[0]({ sysEvent: { eventType: 6 } });

    expect(onSingleTap).not.toHaveBeenCalled();
    expect(onScrollUp).not.toHaveBeenCalled();
    expect(onScrollDown).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("bindTempleEvents routes sysEvent CLICK/SCROLL/DOUBLE_CLICK to gesture handlers", () => {
    vi.useFakeTimers();
    const handlers: Array<(event: unknown) => void> = [];
    const bridge = {
      onEvenHubEvent: vi.fn((handler: (event: unknown) => void) => {
        handlers.push(handler);
      }),
    };
    const onSingleTap = vi.fn();
    const onScrollUp = vi.fn();
    const onScrollDown = vi.fn();
    const onDoubleTap = vi.fn();

    bindTempleEvents(bridge, { onSingleTap, onScrollUp, onScrollDown, onDoubleTap });
    handlers[0]({ sysEvent: { eventType: 0 } });
    vi.advanceTimersByTime(260);
    handlers[0]({ sysEvent: { eventType: 1 } });
    vi.advanceTimersByTime(820);
    handlers[0]({ sysEvent: { eventType: 2 } });
    handlers[0]({ sysEvent: { eventType: 3 } });
    vi.useRealTimers();

    expect(onSingleTap).toHaveBeenCalledTimes(1);
    expect(onScrollUp).toHaveBeenCalledTimes(1);
    expect(onScrollDown).toHaveBeenCalledTimes(1);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });
});
