import { describe, expect, it } from "vitest";
import { summarizeToolCall } from "../src/tool-summary";

describe("summarizeToolCall", () => {
  it("summarizes Bash by normalized command prefix", () => {
    expect(summarizeToolCall("Bash", { command: "pnpm test -- --reporter verbose\n  && pnpm build" })).toBe(
      "Bash: pnpm test -- --reporter verbose && pnpm build",
    );
  });

  it("summarizes file tools by path", () => {
    expect(summarizeToolCall("Read", { file_path: "server/src/stream.ts" })).toBe("Read: server/src/stream.ts");
    expect(summarizeToolCall("Edit", { file_path: "server/src/stream.ts" })).toBe("Edit: edit server/src/stream.ts");
    expect(summarizeToolCall("Write", { path: "frontend/src/main.ts" })).toBe("Write: write frontend/src/main.ts");
  });

  it("summarizes grep-like tools without dumping raw args", () => {
    expect(summarizeToolCall("Grep", { pattern: "JsonlTailer", path: "server/src" })).toBe(
      "Grep: JsonlTailer in server/src",
    );
  });

  it("caps long Bash summaries to a HUD-sized oneliner", () => {
    const summary = summarizeToolCall("Bash", { command: `echo ${"x".repeat(120)}` });

    expect(Array.from(summary).length).toBeLessThanOrEqual(66);
    expect(summary.endsWith("…")).toBe(true);
  });
});
