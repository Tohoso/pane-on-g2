import { describe, expect, it, vi } from "vitest";
import { EventStream, ChunkQueue, parseSseEvents, type EventSourceLike } from "../src/stream";

describe("SSE parsing", () => {
  it("parses named SSE events", () => {
    const parsed = parseSseEvents(
      'id: 42\nevent: text_delta\ndata: {"type":"text_delta","slot":"cc","text":"hello","seq":1,"turnId":"t1","ts":1}\n\n',
    );

    expect(parsed).toEqual([
      {
        id: "42",
        event: "text_delta",
        data: { type: "text_delta", slot: "cc", text: "hello", seq: 1, turnId: "t1", ts: 1 },
      },
    ]);
  });

  it("drains text at 8 chars per tick", async () => {
    const chunks: string[] = [];
    const queue = new ChunkQueue((chunk) => chunks.push(chunk), { chunkSize: 8, intervalMs: 1 });

    queue.push("元気。openclaw rollback");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(chunks).toEqual(["元気。openc", "law roll", "back"]);
  });

  it("uses the last event id as cursor when reconnecting", () => {
    const urls: string[] = [];
    const sources: FakeEventSource[] = [];
    class FakeEventSource implements EventSourceLike {
      listeners = new Map<string, (event: MessageEvent) => void>();
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string) {
        urls.push(url);
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }
      close() {}
    }

    const stream = new EventStream({
      url: "http://server/api/events",
      token: "secret",
      slot: "cc",
      initialLastEventId: "000000000010",
      EventSourceCtor: FakeEventSource,
      maxBackoffMs: 1_000,
      onEvent: () => {},
    });

    stream.connect();
    expect(new URL(urls[0]).searchParams.get("cursor")).toBe("000000000010");

    sources[0].listeners.get("status")?.({
      data: JSON.stringify({ type: "status", slot: "cc", state: "busy", ts: 1 }),
      lastEventId: "000000000011",
    } as MessageEvent);
    stream.close();
    stream.connect();

    expect(new URL(urls[1]).searchParams.get("cursor")).toBe("000000000011");
    stream.close();
  });

  it("passes pane snapshots through without text chunk queueing", () => {
    const sources: FakeEventSource[] = [];
    class FakeEventSource implements EventSourceLike {
      listeners = new Map<string, (event: MessageEvent) => void>();
      onerror: ((event: Event) => void) | null = null;
      constructor(_url: string) {
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }
      close() {}
    }

    const received: unknown[] = [];
    const queue = new ChunkQueue(() => {}, { chunkSize: 1, intervalMs: 1 });
    const push = vi.spyOn(queue, "push");
    const stream = new EventStream({
      url: "http://server/api/events",
      slot: "cc",
      EventSourceCtor: FakeEventSource,
      queue,
      onEvent: (event) => received.push(event),
    });

    stream.connect();
    sources[0].listeners.get("replay_done")?.({ data: "{}", lastEventId: "" } as MessageEvent);
    sources[0].listeners.get("pane_snapshot")?.({
      data: JSON.stringify({ type: "pane_snapshot", slot: "cc", content: "live pane", seq: 3, ts: 10 }),
      lastEventId: "000000000003",
    } as MessageEvent);

    expect(received).toEqual([{ type: "pane_snapshot", slot: "cc", content: "live pane", seq: 3, ts: 10 }]);
    expect(push).not.toHaveBeenCalled();
    stream.close();
  });
});
