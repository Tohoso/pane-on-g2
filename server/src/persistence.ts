import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PaneEvent, Slot } from "@pane-on-g2/shared/protocol";

export type StoredEvent = {
  id: string;
  event: PaneEvent;
};

export type EventPersistence = {
  readonly backend: "sqlite" | "json";
  save(event: StoredEvent): void;
  replayAfter(cursor: string | null, slot?: Slot, limit?: number): StoredEvent[];
  latestId(): string | null;
  close(): void;
};

export type EventPersistenceOptions = {
  dbPath?: string;
  maxEventsPerSlot?: number;
};

const DEFAULT_MAX_EVENTS_PER_SLOT = 10_000;

export function defaultEventsDbPath() {
  return join(homedir(), ".pane-on-g2", "events.db");
}

export function createEventPersistence(options: EventPersistenceOptions = {}): EventPersistence {
  const dbPath = options.dbPath || defaultEventsDbPath();
  const maxEventsPerSlot = options.maxEventsPerSlot ?? DEFAULT_MAX_EVENTS_PER_SLOT;
  const sqlite = tryCreateSqlitePersistence(dbPath, maxEventsPerSlot);
  if (sqlite) return sqlite;
  return new JsonEventPersistence(dbPath, maxEventsPerSlot);
}

function tryCreateSqlitePersistence(dbPath: string, maxEventsPerSlot: number): EventPersistence | null {
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    return new SqliteEventPersistence(Database, dbPath, maxEventsPerSlot);
  } catch {
    return null;
  }
}

function slotOf(event: PaneEvent): Slot | null {
  return "slot" in event ? event.slot : null;
}

class SqliteEventPersistence implements EventPersistence {
  readonly backend = "sqlite" as const;
  private readonly db: any;

  constructor(Database: any, private readonly dbPath: string, private readonly maxEventsPerSlot: number) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        slot TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_slot_id ON events(slot, id);
    `);
  }

  save(stored: StoredEvent): void {
    const slot = slotOf(stored.event);
    if (!slot) return;
    if (stored.event.type === "pane_snapshot") {
      this.db.prepare("DELETE FROM events WHERE slot = ? AND type = ?").run(slot, "pane_snapshot");
    }
    this.db.prepare("INSERT OR REPLACE INTO events(id, slot, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(
      stored.id,
      slot,
      "ts" in stored.event ? stored.event.ts : Date.now(),
      stored.event.type,
      JSON.stringify(stored.event),
    );
    this.db.prepare(`
      DELETE FROM events
      WHERE slot = ?
        AND id NOT IN (
          SELECT id FROM events WHERE slot = ? ORDER BY id DESC LIMIT ?
        )
    `).run(slot, slot, this.maxEventsPerSlot);
  }

  replayAfter(cursor: string | null, slot?: Slot, limit?: number): StoredEvent[] {
    const since = cursor || "000000000000";
    let rows: Array<{ id: string; payload: string }>;
    if (cursor === null && limit && limit > 0) {
      rows = slot
        ? this.db.prepare("SELECT id, payload FROM events WHERE slot = ? ORDER BY id DESC LIMIT ?").all(slot, limit) as Array<{ id: string; payload: string }>
        : this.db.prepare("SELECT id, payload FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<{ id: string; payload: string }>;
      const snapshots = slot
        ? this.db.prepare("SELECT id, payload FROM events WHERE slot = ? AND type = ? ORDER BY id DESC LIMIT 1").all(slot, "pane_snapshot") as Array<{ id: string; payload: string }>
        : this.db.prepare("SELECT id, payload FROM events WHERE type = ? ORDER BY id ASC").all("pane_snapshot") as Array<{ id: string; payload: string }>;
      rows = dedupeRows([...rows, ...snapshots]);
    } else {
      rows = (slot
        ? this.db.prepare("SELECT id, payload FROM events WHERE slot = ? AND id > ? ORDER BY id ASC").all(slot, since)
        : this.db.prepare("SELECT id, payload FROM events WHERE id > ? ORDER BY id ASC").all(since)) as Array<{ id: string; payload: string }>;
    }
    return rows.map((row) => ({ id: row.id, event: JSON.parse(row.payload) as PaneEvent }));
  }

  latestId(): string | null {
    return this.db.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1").get()?.id || null;
  }

  close(): void {
    this.db.close();
  }
}

class JsonEventPersistence implements EventPersistence {
  readonly backend = "json" as const;
  private events: StoredEvent[] = [];

  constructor(private readonly dbPath: string, private readonly maxEventsPerSlot: number) {
    if (dbPath !== ":memory:" && existsSync(dbPath)) {
      try {
        const parsed = JSON.parse(readFileSync(dbPath, "utf8"));
        if (Array.isArray(parsed)) this.events = parsed as StoredEvent[];
      } catch {
        this.events = [];
      }
    }
  }

  save(stored: StoredEvent): void {
    const slot = slotOf(stored.event);
    if (!slot) return;
    this.events = this.events.filter((event) => event.id !== stored.id);
    if (stored.event.type === "pane_snapshot") {
      this.events = this.events.filter((event) => slotOf(event.event) !== slot || event.event.type !== "pane_snapshot");
    }
    this.events.push(stored);
    const slotEvents = this.events.filter((event) => slotOf(event.event) === slot);
    const remove = Math.max(0, slotEvents.length - this.maxEventsPerSlot);
    if (remove > 0) {
      const removeIds = new Set(slotEvents.slice(0, remove).map((event) => event.id));
      this.events = this.events.filter((event) => !removeIds.has(event.id));
    }
    this.events.sort((a, b) => a.id.localeCompare(b.id));
    this.flush();
  }

  replayAfter(cursor: string | null, slot?: Slot, limit?: number): StoredEvent[] {
    const since = cursor || "000000000000";
    const filtered = this.events.filter((event) => event.id > since && (!slot || slotOf(event.event) === slot));
    if (cursor === null && limit && limit > 0 && filtered.length > limit) {
      const limited = filtered.slice(-limit);
      const snapshots = filtered.filter((event) => event.event.type === "pane_snapshot");
      return dedupeStoredEvents([...limited, ...snapshots]);
    }
    return filtered;
  }

  latestId(): string | null {
    return this.events.at(-1)?.id || null;
  }

  close(): void {
    this.flush();
  }

  private flush(): void {
    if (this.dbPath === ":memory:") return;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    writeFileSync(this.dbPath, JSON.stringify(this.events), "utf8");
  }
}

function dedupeRows(rows: Array<{ id: string; payload: string }>): Array<{ id: string; payload: string }> {
  return Array.from(new Map(rows.map((row) => [row.id, row])).values())
    .sort((a, b) => a.id.localeCompare(b.id));
}

function dedupeStoredEvents(events: StoredEvent[]): StoredEvent[] {
  return Array.from(new Map(events.map((event) => [event.id, event])).values())
    .sort((a, b) => a.id.localeCompare(b.id));
}
