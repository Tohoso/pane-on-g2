import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createEventPersistence } from "../src/persistence";
import { EventBroker } from "../src/stream";

const tempDirs: string[] = [];

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "pane-on-g2-persistence-"));
  tempDirs.push(dir);
  return join(dir, "events.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EventPersistence", () => {
  it("replays events after a cursor for one slot", () => {
    const persistence = createEventPersistence({ dbPath: tempDbPath(), maxEventsPerSlot: 10 });

    persistence.save({ id: "000000000001", event: { type: "status", slot: "cc", state: "busy", ts: 1 } });
    persistence.save({ id: "000000000002", event: { type: "text_delta", slot: "cc", text: "cc", seq: 1, turnId: "t", ts: 2 } });
    persistence.save({ id: "000000000003", event: { type: "text_delta", slot: "alpha", text: "alpha", seq: 1, turnId: "a", ts: 3 } });

    expect(persistence.replayAfter("000000000001", "cc").map((event) => event.id)).toEqual(["000000000002"]);
    persistence.close();
  });

  it("keeps a ring buffer per slot", () => {
    const persistence = createEventPersistence({ dbPath: tempDbPath(), maxEventsPerSlot: 2 });

    persistence.save({ id: "000000000001", event: { type: "status", slot: "cc", state: "busy", ts: 1 } });
    persistence.save({ id: "000000000002", event: { type: "status", slot: "cc", state: "idle", ts: 2 } });
    persistence.save({ id: "000000000003", event: { type: "status", slot: "cc", state: "busy", ts: 3 } });
    persistence.save({ id: "000000000004", event: { type: "status", slot: "alpha", state: "busy", ts: 4 } });

    expect(persistence.replayAfter("000000000000", "cc").map((event) => event.id)).toEqual([
      "000000000002",
      "000000000003",
    ]);
    expect(persistence.replayAfter("000000000000", "alpha").map((event) => event.id)).toEqual(["000000000004"]);
    persistence.close();
  });

  it("lets a restarted broker continue after the persisted latest id", () => {
    const persistence = createEventPersistence({ dbPath: tempDbPath(), maxEventsPerSlot: 10 });
    persistence.save({ id: "000000000099", event: { type: "status", slot: "cc", state: "idle", ts: 99 } });

    const broker = new EventBroker(500, persistence);
    const published = broker.publish({ type: "status", slot: "cc", state: "busy", ts: 100 });

    expect(published.id).toBe("000000000100");
    persistence.close();
  });

  it("keeps only the latest pane snapshot for a slot", () => {
    const persistence = createEventPersistence({ dbPath: tempDbPath(), maxEventsPerSlot: 10 });

    persistence.save({ id: "000000000001", event: { type: "pane_snapshot", slot: "cc", content: "old", seq: 1, ts: 1 } });
    persistence.save({ id: "000000000002", event: { type: "status", slot: "cc", state: "busy", ts: 2 } });
    persistence.save({ id: "000000000003", event: { type: "pane_snapshot", slot: "cc", content: "new", seq: 2, ts: 3 } });

    const replay = persistence.replayAfter(null, "cc");

    expect(replay.map((event) => event.event.type)).toEqual(["status", "pane_snapshot"]);
    expect(replay.at(-1)?.event).toMatchObject({ type: "pane_snapshot", content: "new", seq: 2 });
    persistence.close();
  });

  it("replays the latest pane snapshot for each slot", () => {
    const persistence = createEventPersistence({ dbPath: tempDbPath(), maxEventsPerSlot: 10 });

    persistence.save({ id: "000000000001", event: { type: "pane_snapshot", slot: "cc", content: "cc-old", seq: 1, ts: 1 } });
    persistence.save({ id: "000000000002", event: { type: "pane_snapshot", slot: "alpha", content: "alpha-latest", seq: 1, ts: 2 } });
    persistence.save({ id: "000000000003", event: { type: "pane_snapshot", slot: "cc", content: "cc-latest", seq: 2, ts: 3 } });

    const replay = persistence.replayAfter(null);

    expect(replay.map((event) => event.event)).toEqual([
      { type: "pane_snapshot", slot: "alpha", content: "alpha-latest", seq: 1, ts: 2 },
      { type: "pane_snapshot", slot: "cc", content: "cc-latest", seq: 2, ts: 3 },
    ]);
    persistence.close();
  });

  it("includes an older latest pane snapshot in limited fresh replay", () => {
    const persistence = createEventPersistence({ dbPath: tempDbPath(), maxEventsPerSlot: 10 });

    persistence.save({ id: "000000000001", event: { type: "pane_snapshot", slot: "cc", content: "still-current", seq: 1, ts: 1 } });
    persistence.save({ id: "000000000002", event: { type: "status", slot: "cc", state: "busy", ts: 2 } });
    persistence.save({ id: "000000000003", event: { type: "status", slot: "cc", state: "idle", ts: 3 } });

    expect(persistence.replayAfter(null, "cc", 1).map((event) => event.id)).toEqual([
      "000000000001",
      "000000000003",
    ]);
    persistence.close();
  });
});
