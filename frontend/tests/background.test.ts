import { describe, expect, it, vi } from "vitest";
import { bindBackgroundLifecycle } from "../src/background";

describe("bindBackgroundLifecycle", () => {
  it("persists SDK background state and restores it", async () => {
    let restoreHandler: ((state: unknown) => void) | undefined;
    const bridge = {
      setBackgroundState: vi.fn(),
      onBackgroundRestore: vi.fn((handler: (state: unknown) => void) => {
        restoreHandler = handler;
      }),
    };
    const restore = vi.fn();

    const controller = bindBackgroundLifecycle(bridge, {
      snapshot: () => ({ slot: "cc", cursor: "000000000123" }),
      restore,
    });

    await controller.persist();
    expect(bridge.setBackgroundState).toHaveBeenCalledWith({ slot: "cc", cursor: "000000000123" });

    restoreHandler?.({ slot: "alpha", cursor: "000000000124" });
    expect(restore).toHaveBeenCalledWith({ slot: "alpha", cursor: "000000000124" });
  });
});
