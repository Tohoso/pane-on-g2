import type { PaneEvent, Slot } from "@pane-on-g2/shared/protocol";
import type { RawProviderEvent } from "./stream.ts";

export type BusyStatusTrackerOptions = {
  slot: Slot;
  timeoutMs?: number;
  emit: (event: PaneEvent) => void;
  now?: () => number;
};

export class BusyStatusTracker {
  private readonly slot: Slot;
  private readonly timeoutMs: number;
  private readonly emit: (event: PaneEvent) => void;
  private readonly now: () => number;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BusyStatusTrackerOptions) {
    this.slot = options.slot;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.emit = options.emit;
    this.now = options.now || Date.now;
  }

  markBusy(options: { emit?: boolean } = {}): void {
    const shouldEmit = options.emit !== false;
    if (!this.busy) {
      this.busy = true;
      if (shouldEmit) this.emit({ type: "status", slot: this.slot, state: "busy", ts: this.now() });
    }
    this.schedule();
  }

  markUpdate(): void {
    if (this.busy) this.schedule();
  }

  markIdle(options: { emit?: boolean; message?: string } = {}): void {
    const shouldEmit = options.emit !== false;
    if (!this.busy && !this.timer) return;
    this.busy = false;
    this.clear();
    if (shouldEmit) {
      this.emit({ type: "status", slot: this.slot, state: "idle", message: options.message, ts: this.now() });
    }
  }

  recordRawEvent(raw: RawProviderEvent): void {
    if (raw.type === "result") {
      this.markIdle({ emit: false });
      return;
    }
    if (raw.type === "user_prompt" || raw.type === "text_delta" || raw.type === "tool_start") {
      this.markBusy({ emit: false });
      return;
    }
    if (raw.type === "tool_end") this.markUpdate();
  }

  stop(): void {
    this.busy = false;
    this.clear();
  }

  private schedule(): void {
    this.clear();
    this.timer = setTimeout(() => {
      if (!this.busy) return;
      this.busy = false;
      this.timer = null;
      this.emit({
        type: "status",
        slot: this.slot,
        state: "idle",
        message: `No JSONL update for ${Math.round(this.timeoutMs / 1000)}s; soft idle`,
        ts: this.now(),
      });
    }, this.timeoutMs);
  }

  private clear(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
