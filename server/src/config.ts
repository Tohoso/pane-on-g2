import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SLOTS, type RingReplyGesture, type Slot } from "@pane-on-g2/shared/protocol";

export type RingReplyPreset = {
  text: string;
  action: "prompt" | "interrupt";
};

export type AppConfig = {
  label: string;
  slots: readonly Slot[];
  tmuxPrefix: string;
  ringReplies: Record<RingReplyGesture, RingReplyPreset>;
  bind: string;
  port: number;
  tokenFile?: string;
};

export type AppConfigOptions = {
  cwd?: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
};

const DEFAULT_RING_REPLIES: Record<RingReplyGesture, RingReplyPreset> = {
  single_tap: { text: "ack", action: "prompt" },
  double_tap: { text: "progress?", action: "prompt" },
  long_press: { text: "interrupt", action: "interrupt" },
  triple_tap: { text: "be terse", action: "prompt" },
};

const DEFAULT_CONFIG: AppConfig = {
  label: "g2",
  slots: SLOTS,
  tmuxPrefix: "",
  ringReplies: DEFAULT_RING_REPLIES,
  bind: "127.0.0.1",
  port: 3457,
};

type FileConfig = Partial<Pick<AppConfig, "label" | "slots" | "tmuxPrefix">> & {
  ringReplies?: Partial<Record<RingReplyGesture, Partial<RingReplyPreset>>>;
};

export function loadAppConfig(options: AppConfigOptions = {}): AppConfig {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const configPath = options.configPath || resolve(cwd, "pane-on-g2.config.json");
  const fileConfig = readFileConfig(configPath);

  const label = nonEmpty(env.PANE_ON_G2_LABEL) || nonEmpty(fileConfig.label) || DEFAULT_CONFIG.label;
  const slots = normalizeSlots(env.PANE_ON_G2_SLOTS?.split(",") || fileConfig.slots, DEFAULT_CONFIG.slots);
  const tmuxPrefix = env.PANE_ON_G2_TMUX_PREFIX ?? fileConfig.tmuxPrefix ?? DEFAULT_CONFIG.tmuxPrefix;
  const bind = nonEmpty(env.PANE_ON_G2_BIND) || DEFAULT_CONFIG.bind;
  const port = numberEnv(env.PANE_ON_G2_PORT) || DEFAULT_CONFIG.port;
  const tokenFile = nonEmpty(env.PANE_ON_G2_TOKEN_FILE);

  return {
    label,
    slots,
    tmuxPrefix,
    ringReplies: normalizeRingReplies(fileConfig.ringReplies),
    bind,
    port,
    tokenFile,
  };
}

export function applyProviderEnv(config: Pick<AppConfig, "tmuxPrefix">, env: Record<string, string | undefined> = process.env): void {
  env.PANE_ON_G2_TMUX_PREFIX = config.tmuxPrefix;
}

function readFileConfig(path: string): FileConfig {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as FileConfig;
}

function normalizeSlots(value: unknown, fallback: readonly Slot[]): readonly Slot[] {
  if (!Array.isArray(value)) return fallback;
  const slots = value
    .filter((slot): slot is string => typeof slot === "string")
    .map((slot) => slot.trim())
    .filter(Boolean);
  return slots.length > 0 ? Array.from(new Set(slots)) : fallback;
}

function normalizeRingReplies(value: FileConfig["ringReplies"]): Record<RingReplyGesture, RingReplyPreset> {
  const replies = { ...DEFAULT_RING_REPLIES };
  if (!value || typeof value !== "object") return replies;
  for (const gesture of Object.keys(DEFAULT_RING_REPLIES) as RingReplyGesture[]) {
    const preset = value[gesture];
    if (!preset || typeof preset !== "object") continue;
    const text = nonEmpty(preset.text);
    const action = preset.action === "prompt" || preset.action === "interrupt" ? preset.action : undefined;
    replies[gesture] = {
      text: text || replies[gesture].text,
      action: action || replies[gesture].action,
    };
  }
  return replies;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberEnv(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
