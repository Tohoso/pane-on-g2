import type { Slot } from "@pane-on-g2/shared/protocol";
import { capturePane as defaultCapturePane } from "./adapters.ts";

export type PanePollerOptions = {
  intervalMs?: number;
  captureLines?: number;
  capturePane?: (slot: Slot, lines: number) => Promise<string> | string;
  onSnapshot: (slot: Slot, content: string) => void;
};

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_CAPTURE_LINES = 200;
const MAX_VISIBLE_LINES = 200;

export function sanitizeAnsi(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()=>][\x20-\x7e]?/g, "")
    .replace(/[\x00-\x09\x0B-\x1f\x7f]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function trimCcChrome(lines: string[]): string[] {
  let anchor = -1;
  for (let index = 0; index <= lines.length - 3; index += 1) {
    if (
      /─{10,}/.test(lines[index]) &&
      /^\s*❯/.test(lines[index + 1]) &&
      /─{10,}/.test(lines[index + 2])
    ) {
      anchor = index;
    }
  }
  if (anchor < 0) return lines;

  let cut = anchor;
  while (cut > 0) {
    const prev = lines[cut - 1].trim();
    if (prev === "") {
      cut -= 1;
      continue;
    }
    if (/^[◼◻✔⎿]/.test(prev)) {
      cut -= 1;
      continue;
    }
    if (/^…/.test(prev)) {
      cut -= 1;
      continue;
    }
    if (/^\d+ tasks? \(/.test(prev)) {
      cut -= 1;
      continue;
    }
    break;
  }
  while (cut > 0 && lines[cut - 1].trim() === "") cut -= 1;
  return lines.slice(0, cut);
}

export class PanePoller {
  private readonly slot: Slot;
  private readonly intervalMs: number;
  private readonly captureLines: number;
  private readonly capturePane: (slot: Slot, lines: number) => Promise<string> | string;
  private readonly onSnapshot: (slot: Slot, content: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private lastContent = "";

  constructor(slot: Slot, opts: PanePollerOptions) {
    this.slot = slot;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.captureLines = opts.captureLines ?? DEFAULT_CAPTURE_LINES;
    this.capturePane = opts.capturePane || defaultCapturePane;
    this.onSnapshot = opts.onSnapshot;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    try {
      const raw = await Promise.resolve(this.capturePane(this.slot, this.captureLines));
      if (this.stopped || !raw) return;
      const content = snapshotContent(raw);
      if (!content.trim() || content === this.lastContent) return;
      this.lastContent = content;
      this.onSnapshot(this.slot, content);
    } catch {
      // Capture errors are transient: closed tmux session, race during restart, etc.
    } finally {
      if (!this.stopped) this.schedule(this.intervalMs);
    }
  }
}

function snapshotContent(raw: string): string {
  const sanitized = sanitizeAnsi(raw);
  const trimmed = trimCcChrome(sanitized.split("\n"));
  return trimmed.slice(-MAX_VISIBLE_LINES).join("\n");
}
