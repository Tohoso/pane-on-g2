import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureEhpk,
  loadPlaywright,
  main,
  readAppJson,
} from "./upload.mjs";

const playwrightMock = vi.hoisted(() => ({
  chromium: {
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
  },
}));

vi.mock("playwright", () => ({
  chromium: playwrightMock.chromium,
}));

function sink() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      },
    },
    get value() {
      return value;
    },
  };
}

describe("Dev Portal upload CLI", () => {
  it("parses app.json package_id correctly", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pane-on-g2-app-json-"));
    try {
      await writeFile(path.join(tmp, "app.json"), JSON.stringify({
        package_id: "io.github.tohoso.paneong2",
        name: "pane-on-g2",
      }));

      expect(readAppJson(tmp).package_id).toBe("io.github.tohoso.paneong2");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to building the .ehpk when missing", async () => {
    let existsCalls = 0;
    const output = sink();
    const existsSync = vi.fn(() => {
      existsCalls += 1;
      return existsCalls > 1;
    });
    const runBuild = vi.fn(async () => {});

    const built = await ensureEhpk({
      cwd: "/repo",
      ehpkPath: "/repo/pane-on-g2.ehpk",
      existsSync,
      runBuild,
      stdout: output.stream,
    });

    expect(built).toBe(true);
    expect(runBuild).toHaveBeenCalledOnce();
    expect(runBuild).toHaveBeenCalledWith({ cwd: "/repo", stdout: output.stream });
    expect(output.value).toContain("scripts/ehpk.sh");
  });

  it("dispatches to login, publish, and status based on argv", async () => {
    for (const command of ["login", "publish", "status"]) {
      const commands = {
        login: vi.fn(async () => {}),
        publish: vi.fn(async () => {}),
        status: vi.fn(async () => {}),
      };

      await expect(main([command], { commands, stderr: sink().stream })).resolves.toBe(0);
      expect(commands[command]).toHaveBeenCalledOnce();
    }
  });

  it("prints usage and returns 64 for bad args", async () => {
    const error = sink();

    await expect(main(["wat"], { commands: {}, stderr: error.stream })).resolves.toBe(64);
    expect(error.value).toContain("Usage:");
    expect(error.value).toContain("node tools/dev-portal/upload.mjs publish");
  });

  it("uses the mocked Playwright module in tests", async () => {
    await expect(loadPlaywright()).resolves.toMatchObject({
      chromium: playwrightMock.chromium,
    });
  });
});
