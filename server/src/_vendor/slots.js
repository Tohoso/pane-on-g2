// slots.js — slot config + tmux liveness probe
// Each slot runs on its own tmux socket (`tmux -L <slot>`).

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

function defaultSlotsConf() {
  return process.env.PANE_ON_G2_SLOTS_CONF || `${homedir()}/.pane-on-g2/slots.conf`;
}

function defaultTmuxSocketDir() {
  return process.env.PANE_ON_G2_TMUX_SOCKET_DIR || `/tmp/tmux-${process.getuid?.() ?? 1000}`;
}

function defaultClaudeConfigDirRoot() {
  return process.env.PANE_ON_G2_CLAUDE_CONFIG_DIR_ROOT || homedir();
}

function defaultBaseSlots() {
  const raw = process.env.PANE_ON_G2_BASE_SLOTS || "cc";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((slot) => ({
      slot,
      account: process.env.PANE_ON_G2_BASE_SLOT_ACCOUNT || "default",
      configDir: `${defaultClaudeConfigDirRoot()}/.claude${slot === "cc" ? "" : `-${slot}`}`,
    }));
}

function defaultTmuxPrefix() {
  return process.env.PANE_ON_G2_TMUX_PREFIX ?? "";
}

function defaultProjectCwd() {
  return process.env.PANE_ON_G2_SESSION_CWD || process.cwd();
}

function targetForSlot(slot) {
  return `${defaultTmuxPrefix()}${slot}`;
}

export function getConfigDirForSlot(slot) {
  const all = listAllSlots();
  const found = all.find((s) => s.slot === slot);
  if (found?.configDir) return found.configDir;
  return `${defaultClaudeConfigDirRoot()}/.claude${slot === "cc" ? "" : `-${slot}`}`;
}

/**
 * Return the latest session jsonl path for the given slot.
 * Claude Code stores them under `<configDir>/projects/<encoded-cwd>/<uuid>.jsonl`,
 * where `encoded-cwd` is the absolute cwd with `/` replaced by `-`.
 */
export function getLatestSessionJsonl(slot, cwd = defaultProjectCwd()) {
  const configDir = getConfigDirForSlot(slot);
  const encoded = cwd.replace(/^\//, "-").replace(/\//g, "-");
  const projDir = `${configDir}/projects/${encoded}`;
  if (!existsSync(projDir)) return null;

  let latest = null;
  let latestMtime = 0;
  try {
    for (const file of readdirSync(projDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const full = `${projDir}/${file}`;
      const mtime = statSync(full).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = full;
      }
    }
  } catch {
    return null;
  }
  return latest;
}

export function parseSlotsConf(path = defaultSlotsConf()) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const slots = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\t+/);
    if (parts.length < 3) continue;
    const [slot, account, configDir] = parts;
    slots.push({ slot, account, configDir });
  }
  return slots;
}

export function listAllSlots() {
  const conf = parseSlotsConf();
  const merged = [...defaultBaseSlots()];
  for (const s of conf) {
    if (!merged.find((m) => m.slot === s.slot)) merged.push(s);
  }
  return merged;
}

export function isSocketAlive(slot) {
  const path = `${defaultTmuxSocketDir()}/${slot}`;
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

export function isTmuxSessionAlive(slot) {
  if (!isSocketAlive(slot)) return false;
  try {
    execFileSync("tmux", ["-L", slot, "has-session", "-t", targetForSlot(slot)], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export function listLiveSlots() {
  return listAllSlots().filter((s) => isTmuxSessionAlive(s.slot));
}

export function toEvenSession(slot) {
  const label = process.env.PANE_ON_G2_LABEL || "g2";
  return {
    id: `${label}:${slot.slot}`,
    title: `${label} ${slot.slot}`,
    timestamp: new Date().toISOString(),
    cwd: defaultProjectCwd(),
    provider: "pane-on-g2",
    status: "idle",
    account: slot.account,
  };
}

export function parseSlotFromSessionId(sessionId) {
  if (!sessionId) return null;
  const colon = sessionId.indexOf(":");
  if (colon >= 0) return sessionId.slice(colon + 1);
  return sessionId;
}
