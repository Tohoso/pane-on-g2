import type { PaneEvent, Slot, TokenUsage, UserTurnSource } from "@pane-on-g2/shared/protocol";
import { SLOTS, isSlot } from "@pane-on-g2/shared/protocol";
import { authorizeRequest, type AuthConfig } from "./auth.ts";
import { JsonlTailer } from "./adapters.ts";
import { PanePoller } from "./pane-poller.ts";
import type { EventPersistence } from "./persistence.ts";
import { getResumeCursor } from "./reconnect.ts";
import { BusyStatusTracker } from "./status.ts";
import { summarizeToolCall } from "./tool-summary.ts";

export type RawProviderEvent =
  | { type: "system"; subtype?: string }
  | { type: "user_prompt"; text: string; source?: UserTurnSource }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name?: string; toolId?: string; input?: unknown; summary?: string }
  | { type: "tool_end"; name?: string; ok?: boolean; summary?: string; toolId?: string }
  | { type: "result"; success?: boolean; inputTokens?: number; outputTokens?: number; usage?: TokenUsage };

export type NumberedEvent = {
  id: string;
  event: PaneEvent;
};

export function createStreamTranslator(slot: Slot, now: () => number = Date.now) {
  let turnCounter = 0;
  let seq = 0;
  let currentTurnId = "";
  let busy = false;

  function ensureTurnId() {
    if (!currentTurnId) currentTurnId = `${slot}-${now()}-${++turnCounter}`;
    return currentTurnId;
  }

  function busyEvent(): PaneEvent | null {
    if (busy) return null;
    busy = true;
    return { type: "status", slot, state: "busy", ts: now() };
  }

  function mapRawEvent(raw: RawProviderEvent): PaneEvent[] {
    switch (raw.type) {
      case "system":
        return [];
      case "user_prompt": {
        currentTurnId = `${slot}-${now()}-${++turnCounter}`;
        seq = 0;
        const events: PaneEvent[] = [{
          type: "user_prompt",
          slot,
          text: raw.text,
          source: raw.source || classifyUserPromptSource(raw.text),
          ts: now(),
        }];
        const status = busyEvent();
        if (status) events.push(status);
        return events;
      }
      case "text_delta": {
        const events: PaneEvent[] = [];
        const status = busyEvent();
        if (status) events.push(status);
        events.push({ type: "text_delta", slot, text: raw.text, seq: ++seq, turnId: ensureTurnId(), ts: now() });
        return events;
      }
      case "tool_start": {
        const status = busyEvent();
        return [
          ...(status ? [status] : []),
          {
            type: "tool_start",
            slot,
            name: raw.name || "tool",
            summary: raw.summary || summarizeToolCall(raw.name || "tool", raw.input),
            toolId: raw.toolId,
            ts: now(),
          },
        ];
      }
      case "tool_end":
        return [{
          type: "tool_end",
          slot,
          name: raw.name || "tool",
          ok: raw.ok !== false,
          summary: raw.summary,
          toolId: raw.toolId,
          ts: now(),
        }];
      case "result": {
        const usage = raw.usage || {
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          totalTokens: (raw.inputTokens ?? 0) + (raw.outputTokens ?? 0) || undefined,
        };
        const turnId = ensureTurnId();
        busy = false;
        currentTurnId = "";
        seq = 0;
        return [
          { type: "result", slot, turnId, ok: raw.success !== false, usage, ts: now() },
          { type: "status", slot, state: "idle", ts: now() },
        ];
      }
    }
  }

  return { mapRawEvent };
}

export function rawEventsFromClaudeJsonlLine(line: string): RawProviderEvent[] {
  if (!line.trim()) return [];
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }

  if (obj.type === "last-prompt") return [];

  if (obj.type === "user") {
    const text = extractUserText(obj);
    if (!text || text.startsWith("<tool_use_error>") || text.startsWith("[Request interrupted")) return [];
    return [{ type: "user_prompt", text, source: classifyUserPromptSource(text) }];
  }

  if (obj.type !== "assistant") return [];
  const message = obj.message;
  if (!message) return [];

  const events: RawProviderEvent[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      events.push({ type: "text_delta", text: block.text });
    }
    if (block?.type === "tool_use") {
      events.push({
        type: "tool_start",
        name: block.name || "tool",
        toolId: block.id,
        input: block.input,
        summary: summarizeToolCall(block.name || "tool", block.input),
      });
    }
  }

  if (message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence") {
    const usage = message.usage || {};
    events.push({
      type: "result",
      success: true,
      inputTokens: usage.input_tokens || usage.inputTokens || 0,
      outputTokens: usage.output_tokens || usage.outputTokens || 0,
    });
  }

  return events;
}

export function parseClaudeJsonlFixture(content: string, slot: Slot, fixedTs?: number): PaneEvent[] {
  const translator = createStreamTranslator(slot, fixedTs ? () => fixedTs : Date.now);
  const events: PaneEvent[] = [];
  for (const line of content.split("\n")) {
    for (const raw of rawEventsFromClaudeJsonlLine(line)) {
      events.push(...translator.mapRawEvent(raw));
    }
  }
  return events;
}

export class EventBroker {
  private nextId: number;
  private buffer: NumberedEvent[] = [];
  private listeners = new Set<(event: NumberedEvent) => void>();

  constructor(private readonly maxBuffer = 500, private readonly persistence?: EventPersistence) {
    const latest = persistence?.latestId();
    this.nextId = latest ? Number(latest) + 1 : 1;
  }

  publish(event: PaneEvent): NumberedEvent {
    const numbered = { id: String(this.nextId++).padStart(12, "0"), event };
    this.buffer.push(numbered);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    this.persistence?.save(numbered);
    for (const listener of this.listeners) listener(numbered);
    return numbered;
  }

  replayAfter(id: string | null, slot?: Slot, limit?: number): NumberedEvent[] {
    if (this.persistence) return this.persistence.replayAfter(id, slot, limit);
    if (!id) {
      const all = this.buffer.filter((event) => eventMatchesSlot(event.event, slot));
      if (limit && limit > 0 && all.length > limit) return all.slice(-limit);
      return all;
    }
    return this.buffer.filter((event) => event.id > id && eventMatchesSlot(event.event, slot));
  }

  subscribe(listener: (event: NumberedEvent) => void, slot?: Slot): () => void {
    const filtered = (event: NumberedEvent) => {
      if (eventMatchesSlot(event.event, slot)) listener(event);
    };
    this.listeners.add(filtered);
    return () => this.listeners.delete(filtered);
  }
}

export function formatSseRecord(id: string, event: PaneEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createSseHandler(broker: EventBroker, auth: AuthConfig = {}, slots: readonly Slot[] = SLOTS) {
  return function handleSse(request: Request): Response {
    const result = authorizeRequest(request, auth);
    if (!result.ok) {
      return new Response(JSON.stringify({ ok: false, code: result.code, message: result.message }), {
        status: result.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const url = new URL(request.url);
    const slotParam = url.searchParams.get("slot") || "cc";
    if (!isSlot(slotParam, slots)) {
      return new Response(JSON.stringify({ ok: false, code: "BAD_SLOT", message: `slot must be one of: ${slots.join(", ")}` }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const lastEventId = getResumeCursor(request);
    const encoder = new TextEncoder();
    const initialLimitParam = url.searchParams.get("limit");
    const initialLimit = initialLimitParam ? Math.max(1, Math.min(2000, Number(initialLimitParam))) : 200;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (record: string) => controller.enqueue(encoder.encode(record));
        for (const event of broker.replayAfter(lastEventId, slotParam, initialLimit)) write(formatSseRecord(event.id, event.event));
        write(`event: replay_done\ndata: ${JSON.stringify({ type: "replay_done", ts: Date.now() })}\n\n`);

        const unsubscribe = broker.subscribe((event) => write(formatSseRecord(event.id, event.event)), slotParam);
        const heartbeat = setInterval(() => {
          const event: PaneEvent = { type: "heartbeat", ts: Date.now() };
          write(`event: heartbeat\ndata: ${JSON.stringify(event)}\n\n`);
        }, 25_000);

        request.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed by the runtime.
          }
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  };
}

function eventMatchesSlot(event: PaneEvent, slot?: Slot): boolean {
  if (!slot) return true;
  return !("slot" in event) || event.slot === slot;
}

function defaultSessionCwd() {
  return process.env.PANE_ON_G2_SESSION_CWD || process.cwd();
}

export function startCcJsonlMirror(broker: EventBroker, slot: Slot = "cc", cwd = defaultSessionCwd()) {
  return startSlotJsonlMirror(broker, slot, cwd);
}

export function startSlotJsonlMirror(broker: EventBroker, slot: Slot, cwd = defaultSessionCwd()) {
  const translator = createStreamTranslator(slot);
  const status = new BusyStatusTracker({ slot, emit: (event) => broker.publish(event) });
  const tailer = new JsonlTailer(slot, (raw: RawProviderEvent) => {
    if (raw.type === "text_delta") return;
    status.recordRawEvent(raw);
    for (const event of translator.mapRawEvent(raw)) broker.publish(event);
  }, { cwd });
  tailer.start();
  return () => {
    status.stop();
    tailer.stop();
  };
}

export function startAllJsonlMirrors(broker: EventBroker, slots: readonly Slot[] = SLOTS) {
  const stops = slots.map((slot) => startSlotJsonlMirror(broker, slot));
  return () => stops.forEach((stop) => stop());
}

export function startAllPanePollers(broker: EventBroker, slots: readonly Slot[] = SLOTS) {
  const seqBySlot = Object.fromEntries(slots.map((slot) => [slot, 0])) as Record<Slot, number>;
  const pollers = slots.map((slot) => new PanePoller(slot, {
    onSnapshot: (snapshotSlot, content) => {
      broker.publish({
        type: "pane_snapshot",
        slot: snapshotSlot,
        content,
        ts: Date.now(),
        seq: ++seqBySlot[snapshotSlot],
      });
    },
  }));
  for (const poller of pollers) poller.start();
  return () => {
    for (const poller of pollers) {
      try {
        poller.stop();
      } catch {
        // Best-effort shutdown; one stopped poller should not leak the rest.
      }
    }
  };
}

function extractUserText(obj: any): string {
  const content = obj.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" || typeof block === "string")
    .map((block) => (typeof block === "string" ? block : block.text || ""))
    .join("\n")
    .trim();
}

export function classifyUserPromptSource(text: string): UserTurnSource {
  const trimmed = text.trim();
  if (/^\[discord\]/i.test(trimmed)) return "discord";
  if (/<<autonomous-loop(?:-[^>]*)?>>/.test(trimmed)) return "cron";
  return "tmux";
}
