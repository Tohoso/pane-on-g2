import { describe, expect, it } from "vitest";
import { createEventPersistence } from "../src/persistence";
import { getResumeCursor } from "../src/reconnect";
import { EventBroker, createSseHandler } from "../src/stream";

async function readFirstChunk(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return new TextDecoder().decode(value);
}

describe("SSE reconnect replay", () => {
  it("resolves Last-Event-ID before query cursors", () => {
    const request = new Request("http://localhost/api/events?cursor=000000000001&since=000000000002", {
      headers: { "last-event-id": "000000000003" },
    });

    expect(getResumeCursor(request)).toBe("000000000003");
  });

  it("replays persisted events after since cursor", async () => {
    const persistence = createEventPersistence({ dbPath: ":memory:", maxEventsPerSlot: 10 });
    const broker = new EventBroker(2, persistence);
    broker.publish({ type: "text_delta", slot: "cc", text: "old", seq: 1, turnId: "t", ts: 1 });
    broker.publish({ type: "text_delta", slot: "cc", text: "new", seq: 2, turnId: "t", ts: 2 });

    const handler = createSseHandler(broker, { token: "secret" });
    const response = handler(new Request("http://localhost/api/events?slot=cc&since=000000000001", {
      headers: { authorization: "Bearer secret" },
      signal: AbortSignal.timeout(500),
    }));

    expect(response.status).toBe(200);
    const chunk = await readFirstChunk(response);
    expect(chunk).toContain("new");
    expect(chunk).not.toContain("old");
    persistence.close();
  });
});
