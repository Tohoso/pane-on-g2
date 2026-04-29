import { describe, expect, it, vi } from "vitest";
import { BleRecoveryController } from "../src/ble-recovery";

describe("BleRecoveryController", () => {
  it("marks disconnected and retries bridge reconnect with backoff", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, () => void>();
    const reconnect = vi.fn();
    const states: string[] = [];
    const controller = new BleRecoveryController({
      bridge: {
        onEvent: (name, handler) => handlers.set(name, handler),
        reconnect,
      },
      onStateChange: (state) => states.push(state),
      initialDelayMs: 100,
      maxDelayMs: 500,
    });

    controller.start();
    handlers.get("ble_disconnected")?.();
    expect(states).toContain("disconnected");

    await vi.advanceTimersByTimeAsync(100);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("reconnecting");

    handlers.get("ble_connected")?.();
    expect(states.at(-1)).toBe("connected");
    controller.stop();
    vi.useRealTimers();
  });
});
