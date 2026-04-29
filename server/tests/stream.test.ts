import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStreamTranslator, formatSseRecord, parseClaudeJsonlFixture, rawEventsFromClaudeJsonlLine } from "../src/stream";

const here = dirname(fileURLToPath(import.meta.url));

describe("JSONL stream translation", () => {
  it("maps fixture JSONL to PaneEvent order without last-prompt idle", () => {
    const fixture = readFileSync(join(here, "fixtures/cc-session.jsonl"), "utf8");
    const events = parseClaudeJsonlFixture(fixture, "cc", 1_777_275_600_000);

    expect(events.map((event) => event.type)).toEqual([
      "user_prompt",
      "status",
      "text_delta",
      "tool_start",
      "result",
      "status",
    ]);
    expect(events[0]).toMatchObject({ type: "user_prompt", slot: "cc", text: "G2から短く返して" });
    expect(events[2]).toMatchObject({ type: "text_delta", slot: "cc", text: "了解、生存。", seq: 1 });
    expect(events[3]).toMatchObject({ type: "tool_start", name: "Bash", summary: "Bash: pnpm test" });
    expect(events.at(-1)).toMatchObject({ type: "status", state: "idle" });
  });

  it("formats SSE with id, event, and data fields", () => {
    const translator = createStreamTranslator("cc", () => 123);
    const event = translator.mapRawEvent({ type: "text_delta", text: "abc" }).at(-1)!;

    expect(formatSseRecord("000000000001", event)).toBe(
      `id: 000000000001\nevent: text_delta\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });

  it("classifies JSONL user prompts by source", () => {
    const discord = rawEventsFromClaudeJsonlLine(JSON.stringify({ type: "user", message: { content: "[discord] ping" } }));
    const cron = rawEventsFromClaudeJsonlLine(JSON.stringify({ type: "user", message: { content: "<<autonomous-loop-dynamic>>" } }));
    const tmux = rawEventsFromClaudeJsonlLine(JSON.stringify({ type: "user", message: { content: "tmux input" } }));

    expect(discord[0]).toMatchObject({ type: "user_prompt", source: "discord" });
    expect(cron[0]).toMatchObject({ type: "user_prompt", source: "cron" });
    expect(tmux[0]).toMatchObject({ type: "user_prompt", source: "tmux" });
  });
});
