import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadLabel(): string {
  if (process.env.VITE_PANE_ON_G2_LABEL) return process.env.VITE_PANE_ON_G2_LABEL;
  if (process.env.PANE_ON_G2_LABEL) return process.env.PANE_ON_G2_LABEL;

  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const configPath = resolve(root, "pane-on-g2.config.json");
  if (!existsSync(configPath)) return "g2";

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { label?: unknown };
    return typeof parsed.label === "string" && parsed.label.trim() ? parsed.label.trim() : "g2";
  } catch {
    return "g2";
  }
}

export default defineConfig({
  define: {
    "import.meta.env.VITE_PANE_ON_G2_LABEL": JSON.stringify(loadLabel()),
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://localhost:3457",
    },
  },
});
