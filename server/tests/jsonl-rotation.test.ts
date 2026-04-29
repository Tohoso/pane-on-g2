import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeClaudeProject(slot: string) {
  const root = mkdtempSync(join(tmpdir(), "pane-on-g2-jsonl-"));
  tempDirs.push(root);
  const configDir = join(root, "claude-alpha");
  const cwd = join(root, "workspace");
  const encoded = cwd.replace(/^\//, "-").replace(/\//g, "-");
  const projectDir = join(configDir, "projects", encoded);
  mkdirSync(projectDir, { recursive: true });
  const slotsConf = join(root, "slots.conf");
  writeFileSync(slotsConf, `${slot}\taccount\t${configDir}\n`);
  return { root, cwd, projectDir, slotsConf };
}

afterEach(() => {
  vi.resetModules();
  delete process.env["PANE_ON_G2_SLOTS_CONF"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("JsonlTailer rotation", () => {
  it("switches to the newest session jsonl when Claude Code rotates sessions", async () => {
    const { cwd, projectDir, slotsConf } = makeClaudeProject("alpha");
    process.env["PANE_ON_G2_SLOTS_CONF"] = slotsConf;
    vi.resetModules();
    const { JsonlTailer } = await import("../src/_vendor/jsonl-tail.js");

    const first = join(projectDir, "first.jsonl");
    const second = join(projectDir, "second.jsonl");
    writeFileSync(first, "");
    utimesSync(first, new Date(1_000), new Date(1_000));

    const events: Array<{ type: string; text?: string }> = [];
    const tailer = new JsonlTailer("alpha", (event: { type: string; text?: string }) => events.push(event), {
      cwd,
      pollMs: 5,
    });

    tailer._refreshPath();
    appendFileSync(first, JSON.stringify({ type: "user", message: { content: "first turn" } }) + "\n");
    tailer._readNew(statSync(first).size);
    expect(events.some((event) => event.type === "user_prompt" && event.text === "first turn")).toBe(true);
    utimesSync(first, new Date(1_000), new Date(1_000));

    writeFileSync(second, "");
    utimesSync(second, new Date(3_000), new Date(3_000));
    tailer._refreshPath();
    appendFileSync(second, JSON.stringify({ type: "user", message: { content: "second turn" } }) + "\n");
    tailer._readNew(statSync(second).size);

    expect(events.some((event) => event.type === "user_prompt" && event.text === "second turn")).toBe(true);
    tailer.stop();
  });
});
