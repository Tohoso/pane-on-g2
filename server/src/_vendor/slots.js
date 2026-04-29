// slots.js — ayu-slots.conf パーサ + 生存判定
// 各 slot は別 tmux socket (tmux -L <slot>) で動く独立 server。

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SLOTS_CONF = process.env.AYU_SLOTS_CONF || "/srv/ayu-workspace/tools/ayu-slots.conf";
const TMUX_SOCKET_DIR = process.env.AYU_TMUX_SOCKET_DIR || "/tmp/tmux-1001";

// gamma を含む全スロット (ayu-slots.conf には alpha/beta/gamma しかないが cc は base なので追加)
// AGENTS.md: cc は対話主窓口 (gmail account)
const BASE_SLOTS = [
  { slot: "cc", account: "gmail", configDir: "/home/openclaw/.claude" },
];

// 各 slot の Claude Code config dir 上書き (slots.conf にあるならそれを優先)
export function getConfigDirForSlot(slot) {
  const all = listAllSlots();
  const found = all.find(s => s.slot === slot);
  return found?.configDir || `/home/openclaw/.claude-${slot}`;
}

/**
 * 指定 slot の最新 session jsonl path を返す。
 * Claude Code は config_dir/projects/<encoded-cwd>/<uuid>.jsonl 形式で保存する。
 * encoded-cwd は cwd を `/` で区切って `-` にした dir 名。
 */
export function getLatestSessionJsonl(slot, cwd = "/srv/ayu-workspace") {
  const configDir = getConfigDirForSlot(slot);
  const encoded = cwd.replace(/^\//, "-").replace(/\//g, "-");
  const projDir = `${configDir}/projects/${encoded}`;
  if (!existsSync(projDir)) return null;

  let latest = null;
  let latestMtime = 0;
  try {
    const { readdirSync, statSync: st } = require_fs();
    for (const file of readdirSync(projDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const full = `${projDir}/${file}`;
      const mtime = st(full).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = full;
      }
    }
  } catch { return null; }
  return latest;
}

// CommonJS-style fs require for getLatestSessionJsonl readdirSync usage in ESM
function require_fs() {
  return { readdirSync: _readdirSync, statSync: _statSync };
}
import { readdirSync as _readdirSync, statSync as _statSync } from "node:fs";

export function parseSlotsConf(path = SLOTS_CONF) {
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
  // base (cc) + conf (alpha/beta/gamma)
  const merged = [...BASE_SLOTS];
  for (const s of conf) {
    if (!merged.find(m => m.slot === s.slot)) merged.push(s);
  }
  return merged;
}

/**
 * Tmux socket が存在するか (slot が起動済みか)。
 * /tmp/tmux-1001/<slot> が socket file として存在すれば alive。
 */
export function isSocketAlive(slot) {
  const path = `${TMUX_SOCKET_DIR}/${slot}`;
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * tmux session が存在するか (実際に attach 可能か)
 * 名前は ayu-<slot> の規約 (AGENTS.md より)
 */
export function isTmuxSessionAlive(slot) {
  if (!isSocketAlive(slot)) return false;
  try {
    execFileSync("tmux", ["-L", slot, "has-session", "-t", `ayu-${slot}`], {
      stdio: "ignore",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export function listLiveSlots() {
  return listAllSlots().filter(s => isTmuxSessionAlive(s.slot));
}

/**
 * Even Terminal の session 形式に変換
 */
export function toEvenSession(slot) {
  return {
    id: `ayu:${slot.slot}`,
    title: `歩優 ${slot.slot}`,
    timestamp: new Date().toISOString(),
    cwd: "/srv/ayu-workspace",
    provider: "ayu",
    status: "idle",
    account: slot.account,
  };
}

/**
 * "ayu:cc" → "cc" に変換
 */
export function parseSlotFromSessionId(sessionId) {
  if (!sessionId) return null;
  if (sessionId.startsWith("ayu:")) return sessionId.slice(4);
  // 後方互換: "cc" 直接指定も許容
  return sessionId;
}
