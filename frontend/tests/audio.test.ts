import { describe, expect, it, vi } from "vitest";
import { AudioController, concatPcm, type AudioUploadResult } from "../src/audio";

describe("audio lifecycle", () => {
  it("concats PCM chunks without mutating them", () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4, 5]);

    expect(Array.from(concatPcm([first, second]))).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(first)).toEqual([1, 2]);
  });

  it("starts bridge audio control and buffers chunks only while recording", async () => {
    const audioControl = vi.fn();
    const upload = vi.fn();
    const controller = new AudioController({
      bridge: { audioControl },
      getSlot: () => "alpha",
      uploadPcm: upload,
    });

    controller.handleAudio(new Uint8Array([0]));
    await controller.start();
    controller.handleAudio(new Uint8Array([1, 2]));
    controller.handleAudio(new Uint8Array([3]));

    expect(controller.state).toBe("recording");
    expect(controller.bufferedBytes).toBe(3);
    expect(audioControl).toHaveBeenCalledWith(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it("stops bridge audio control and uploads merged PCM for the current slot", async () => {
    const audioControl = vi.fn();
    const upload = vi.fn(async () => ({ ok: true as const, transcribed: "hello", requestId: "voice-1" }));
    const controller = new AudioController({
      bridge: { audioControl },
      getSlot: () => "gamma",
      uploadPcm: upload,
    });

    await controller.start();
    controller.handleAudio(new Uint8Array([1, 2]));
    controller.handleAudio(new Uint8Array([3]));
    await controller.stop();

    expect(audioControl).toHaveBeenLastCalledWith(false);
    expect(upload).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "gamma");
    expect(controller.state).toBe("idle");
    expect(controller.bufferedBytes).toBe(0);
  });

  it("toggle starts recording from idle", async () => {
    const audioControl = vi.fn();
    const controller = new AudioController({
      bridge: { audioControl },
      getSlot: () => "cc",
      uploadPcm: vi.fn(),
    });

    await controller.toggle();

    expect(controller.state).toBe("recording");
    expect(audioControl).toHaveBeenCalledWith(true);
  });

  it("toggle stops and uploads when recording", async () => {
    const audioControl = vi.fn();
    const upload = vi.fn(async () => ({ ok: true as const, transcribed: "hello", requestId: "voice-1" }));
    const controller = new AudioController({
      bridge: { audioControl },
      getSlot: () => "beta",
      uploadPcm: upload,
    });

    await controller.toggle();
    controller.handleAudio(new Uint8Array([7, 8]));
    const result = await controller.toggle();

    expect(audioControl).toHaveBeenLastCalledWith(false);
    expect(upload).toHaveBeenCalledWith(new Uint8Array([7, 8]), "beta");
    expect(result).toEqual({ ok: true, transcribed: "hello", requestId: "voice-1" });
    expect(controller.state).toBe("idle");
  });

  it("toggle no-ops while uploading", async () => {
    const audioControl = vi.fn();
    let resolveUpload!: (result: AudioUploadResult) => void;
    const upload = vi.fn(() => new Promise<AudioUploadResult>((resolve) => {
      resolveUpload = resolve;
    }));
    const controller = new AudioController({
      bridge: { audioControl },
      getSlot: () => "cc",
      uploadPcm: upload,
    });

    await controller.start();
    controller.handleAudio(new Uint8Array([1]));
    const stopPromise = controller.toggle();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.state).toBe("uploading");
    await controller.toggle();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(audioControl).toHaveBeenCalledTimes(2);

    resolveUpload({ ok: true, transcribed: "done", requestId: "voice-2" });
    await stopPromise;
    expect(controller.state).toBe("idle");
  });

  it("onStateChange fires on each transition", async () => {
    const states: string[] = [];
    const controller = new AudioController({
      bridge: { audioControl: vi.fn() },
      getSlot: () => "alpha",
      uploadPcm: vi.fn(async () => ({ ok: true as const, transcribed: "hello", requestId: "voice-1" })),
    });
    controller.onStateChange((state) => states.push(state));

    await controller.start();
    controller.handleAudio(new Uint8Array([1]));
    await controller.stop();

    expect(states).toEqual(["recording", "uploading", "idle"]);
  });
});
