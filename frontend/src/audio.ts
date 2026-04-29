import type { Slot } from "./types";

export type AudioState = "idle" | "recording" | "uploading";

export type AudioBridge = {
  audioControl: (enabled: boolean) => void | Promise<void>;
  onEvent?: (name: string, handler: (event?: unknown) => void) => void;
  addEventListener?: (name: string, handler: (event?: unknown) => void) => void;
  onAudio?: (handler: (event: { audioPcm?: Uint8Array }) => void) => void;
};

export type AudioUploadResult =
  | { ok: true; transcribed: string; requestId: string }
  | { ok: false; code: string; message: string };

export type AudioControllerOptions = {
  bridge: AudioBridge;
  getSlot: () => Slot;
  uploadPcm: (pcm: Uint8Array, slot: Slot) => Promise<AudioUploadResult> | AudioUploadResult;
};

export class AudioController {
  private readonly bridge: AudioBridge;
  private readonly getSlot: () => Slot;
  private readonly uploadPcm: AudioControllerOptions["uploadPcm"];
  private readonly stateHandlers = new Set<(state: AudioState) => void>();
  private chunks: Uint8Array[] = [];
  state: AudioState = "idle";
  error?: string;

  constructor(options: AudioControllerOptions) {
    this.bridge = options.bridge;
    this.getSlot = options.getSlot;
    this.uploadPcm = options.uploadPcm;
  }

  get bufferedBytes(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  onStateChange(handler: (state: AudioState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  async toggle(): Promise<AudioUploadResult | null | void> {
    if (this.state === "idle") return await this.start();
    if (this.state === "recording") return await this.stop();
    return null;
  }

  async start(): Promise<void> {
    this.error = undefined;
    this.chunks = [];
    this.setState("recording");
    await this.bridge.audioControl(true);
  }

  handleAudio(audioPcm: Uint8Array): void {
    if (this.state !== "recording") return;
    this.chunks.push(new Uint8Array(audioPcm));
  }

  async stop(): Promise<AudioUploadResult | null> {
    if (this.state !== "recording") return null;
    await this.bridge.audioControl(false);
    this.setState("uploading");
    const pcm = concatPcm(this.chunks);
    this.chunks = [];

    try {
      const result = pcm.byteLength > 0 ? await this.uploadPcm(pcm, this.getSlot()) : null;
      this.setState("idle");
      if (result?.ok === false) this.error = result.message;
      return result;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "audio upload failed";
      this.setState("idle");
      return { ok: false, code: "AUDIO_UPLOAD_FAILED", message: this.error };
    } finally {
      this.chunks = [];
    }
  }

  async cancel(): Promise<void> {
    this.chunks = [];
    if (this.state === "recording" || this.state === "uploading") await this.bridge.audioControl(false);
    this.setState("idle");
  }

  private setState(state: AudioState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}

export function concatPcm(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function createPcmUploader(options: { apiBase?: string; token: string; deviceId?: string }) {
  return async function uploadPcm(pcm: Uint8Array, slot: Slot): Promise<AudioUploadResult> {
    const url = new URL(`${options.apiBase || ""}/api/audio`, globalThis.location?.origin || "http://localhost:5173");
    url.searchParams.set("slot", slot);
    url.searchParams.set("requestId", randomRequestId("audio"));

    const body = new ArrayBuffer(pcm.byteLength);
    new Uint8Array(body).set(pcm);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "authorization": `Bearer ${options.token}`,
        "content-type": "application/octet-stream",
        "x-pane-on-g2-device-id": options.deviceId || "even-webview",
      },
      body,
    });

    return await response.json() as AudioUploadResult;
  };
}

function randomRequestId(prefix: string): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function bindAudioLifecycle(bridge: AudioBridge, controller: AudioController): void {
  bridge.onAudio?.((event) => {
    if (event.audioPcm) controller.handleAudio(event.audioPcm);
  });
}
