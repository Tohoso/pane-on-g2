import type { PaneEvent, Slot } from "./types";

export type ParsedSseEvent = {
  id?: string;
  event: string;
  data: unknown;
};

export type ChunkQueueOptions = {
  chunkSize?: number;
  intervalMs?: number;
};

export function parseSseEvents(input: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const block of input.split(/\n\n+/)) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let event = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    if (dataLines.length === 0) continue;
    const rawData = dataLines.join("\n");
    let data: unknown = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // SSE permits plain string data; keep it as-is.
    }
    events.push({ id, event, data });
  }
  return events;
}

export class ChunkQueue {
  private readonly chunkSize: number;
  private readonly intervalMs: number;
  private readonly onChunk: (chunk: string) => void;
  private queue: string[] = [];
  private draining = false;

  constructor(onChunk: (chunk: string) => void, options: ChunkQueueOptions = {}) {
    this.onChunk = onChunk;
    this.chunkSize = options.chunkSize ?? 8;
    this.intervalMs = options.intervalMs ?? 30;
  }

  push(text: string) {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += this.chunkSize) {
      this.queue.push(chars.slice(i, i + this.chunkSize).join(""));
    }
    this.drain();
  }

  size() {
    return this.queue.length;
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    const tick = () => {
      const chunk = this.queue.shift();
      if (!chunk) {
        this.draining = false;
        return;
      }
      this.onChunk(chunk);
      setTimeout(tick, this.intervalMs);
    };
    setTimeout(tick, 0);
  }
}

export type EventSourceLike = {
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  close: () => void;
  onerror: ((event: Event) => void) | null;
};

export type EventSourceCtor = new (url: string) => EventSourceLike;

export type EventStreamOptions = {
  url?: string;
  token?: string;
  slot?: Slot;
  initialLastEventId?: string;
  onEvent: (event: PaneEvent) => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
  onCursor?: (id: string) => void;
  onReplayDone?: () => void;
  EventSourceCtor?: EventSourceCtor;
  queue?: ChunkQueue;
  maxBackoffMs?: number;
};

export class EventStream {
  private readonly options: EventStreamOptions;
  private source: EventSourceLike | null = null;
  private reconnectMs = 1_000;
  private stopped = false;
  private readonly queue: ChunkQueue;
  private lastEventId: string | undefined;
  private inReplay = true;

  constructor(options: EventStreamOptions) {
    this.options = options;
    this.lastEventId = options.initialLastEventId;
    this.queue = options.queue || new ChunkQueue((chunk) => {
      this.options.onEvent({
        type: "text_delta",
        slot: this.options.slot || "cc",
        text: chunk,
        seq: 0,
        turnId: "client-stream",
        ts: Date.now(),
      });
    });
  }

  connect() {
    this.stopped = false;
    this.inReplay = true;
    const EventSourceImpl = this.options.EventSourceCtor || globalThis.EventSource;
    if (!EventSourceImpl) throw new Error("EventSource is not available in this runtime");

    const url = new URL(this.options.url || "/api/events", globalThis.location?.origin || "http://localhost:5173");
    if (this.options.token) url.searchParams.set("token", this.options.token);
    url.searchParams.set("slot", this.options.slot || "cc");
    if (this.lastEventId) url.searchParams.set("cursor", this.lastEventId);

    this.source = new EventSourceImpl(url.toString());
    for (const type of ["heartbeat", "status", "user_prompt", "text_delta", "pane_snapshot", "tool_start", "tool_end", "result", "error"]) {
      this.source.addEventListener(type, (event) => this.handleMessage(event));
    }
    this.source.addEventListener("replay_done", () => {
      this.inReplay = false;
      this.options.onReplayDone?.();
    });
    this.source.onerror = () => this.handleDisconnect();
  }

  close() {
    this.stopped = true;
    this.source?.close();
    this.source = null;
  }

  private handleMessage(event: MessageEvent) {
    if (event.lastEventId) {
      this.lastEventId = event.lastEventId;
      this.options.onCursor?.(event.lastEventId);
    }
    const parsed = JSON.parse(event.data) as PaneEvent;
    this.reconnectMs = 1_000;
    if (parsed.type === "text_delta") {
      if (this.inReplay) {
        this.options.onEvent(parsed);
      } else {
        this.queue.push(parsed.text);
      }
      return;
    }
    this.options.onEvent(parsed);
  }

  private handleDisconnect() {
    if (this.stopped) return;
    this.source?.close();
    this.source = null;
    this.options.onDisconnect?.();
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, this.options.maxBackoffMs ?? 30_000);
    setTimeout(() => {
      if (this.stopped) return;
      this.options.onReconnect?.();
      this.connect();
    }, delay);
  }
}
