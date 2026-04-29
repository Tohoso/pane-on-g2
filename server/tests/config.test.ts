import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { applyProviderEnv, loadAppConfig } from "../src/config";

describe("app config", () => {
  it("uses OSS defaults when the config file is missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pane-on-g2-config-"));

    expect(loadAppConfig({ cwd, env: {} })).toMatchObject({
      label: "g2",
      slots: ["cc", "alpha", "beta", "gamma"],
      tmuxPrefix: "",
      bind: "127.0.0.1",
      port: 3457,
    });
  });

  it("reads pane-on-g2.config.json and lets env override deployment knobs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pane-on-g2-config-"));
    writeFileSync(join(cwd, "pane-on-g2.config.json"), JSON.stringify({
      label: "hud",
      slots: ["main", "worker"],
      tmuxPrefix: "tmux-",
      ringReplies: {
        single_tap: { text: "ok", action: "prompt" },
      },
    }));

    expect(loadAppConfig({
      cwd,
      env: {
        PANE_ON_G2_LABEL: "lens",
        PANE_ON_G2_TMUX_PREFIX: "",
        PANE_ON_G2_BIND: "127.0.0.1",
        PANE_ON_G2_PORT: "3457",
      },
    })).toMatchObject({
      label: "lens",
      slots: ["main", "worker"],
      tmuxPrefix: "",
      bind: "127.0.0.1",
      port: 3457,
      ringReplies: {
        single_tap: { text: "ok", action: "prompt" },
        long_press: { text: "interrupt", action: "interrupt" },
      },
    });
  });

  it("projects tmux prefix into provider env", () => {
    const env: Record<string, string | undefined> = {};

    applyProviderEnv({ tmuxPrefix: "cc-" }, env);

    expect(env.PANE_ON_G2_TMUX_PREFIX).toBe("cc-");
  });
});
