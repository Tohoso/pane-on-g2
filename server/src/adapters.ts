import { execFileSync } from "node:child_process";

const slotsModule = await import("./_vendor/slots.js");
const jsonlModule = await import("./_vendor/jsonl-tail.js");
const TMUX_TIMEOUT_MS = 5_000;

export const listAllSlots = slotsModule.listAllSlots as () => unknown[];
export const listLiveSlots = slotsModule.listLiveSlots as () => unknown[];
export const getLatestSessionJsonl = slotsModule.getLatestSessionJsonl as (slot: string, cwd?: string) => string | null;
export const isTmuxSessionAlive = slotsModule.isTmuxSessionAlive as (slot: string) => boolean;
export const parseSlotFromSessionId = slotsModule.parseSlotFromSessionId as (sessionId: string) => string | null;

export function targetForSlot(slot: string): string {
  return `${process.env.PANE_ON_G2_TMUX_PREFIX ?? ""}${slot}`;
}

export function sendText(slot: string, text: string): void {
  const target = targetForSlot(slot);
  const safeText = text.replace(/\r/g, "").replace(/\n/g, " / ");
  tmuxSync(slot, ["send-keys", "-t", target, "-l", safeText]);
  tmuxSync(slot, ["send-keys", "-t", target, "Enter"]);
}

export function sendInterrupt(slot: string): void {
  tmuxSync(slot, ["send-keys", "-t", targetForSlot(slot), "C-c"]);
}

export function capturePane(slot: string, lines = 200): string {
  return tmuxSync(slot, ["capture-pane", "-t", targetForSlot(slot), "-p", "-S", `-${lines}`]);
}

export function paneStatus(slot: string, busyThresholdMs = 30_000): string {
  const epoch = lastActivityEpoch(slot);
  if (!epoch) return "unknown";
  return Date.now() - epoch * 1000 < busyThresholdMs ? "busy" : "idle";
}

function lastActivityEpoch(slot: string): number | null {
  try {
    const out = tmuxSync(slot, ["list-panes", "-t", targetForSlot(slot), "-F", "#{window_activity}"]);
    const epoch = Number.parseInt(out.trim(), 10);
    return Number.isNaN(epoch) ? null : epoch;
  } catch {
    return null;
  }
}

function tmuxSync(slot: string, args: string[]): string {
  const cleanEnv = { ...process.env };
  delete cleanEnv.TMUX;
  delete cleanEnv.TMUX_PANE;
  return execFileSync("tmux", ["-L", slot, ...args], {
    timeout: TMUX_TIMEOUT_MS,
    encoding: "utf8",
    env: cleanEnv,
  });
}

export const JsonlTailer = jsonlModule.JsonlTailer as new (
  slot: string,
  onEvent: (event: any) => void,
  options?: { cwd?: string },
) => { start: () => void; stop: () => void };
