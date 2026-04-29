import type { Slot, Turn } from "./types";

type SdkCtor = new (data?: unknown) => Record<string, unknown>;

class PlainPayload {
  constructor(data?: Record<string, unknown>) {
    if (data) Object.assign(this, data);
  }
}

let sdkClasses: { CreateStartUpPageContainer: SdkCtor; TextContainerProperty: SdkCtor; TextContainerUpgrade: SdkCtor } = {
  CreateStartUpPageContainer: PlainPayload as unknown as SdkCtor,
  TextContainerProperty: PlainPayload as unknown as SdkCtor,
  TextContainerUpgrade: PlainPayload as unknown as SdkCtor,
};

import("@evenrealities/even_hub_sdk").then((m) => {
  sdkClasses = {
    CreateStartUpPageContainer: m.CreateStartUpPageContainer as unknown as SdkCtor,
    TextContainerProperty: m.TextContainerProperty as unknown as SdkCtor,
    TextContainerUpgrade: m.TextContainerUpgrade as unknown as SdkCtor,
  };
}).catch(() => {});

const textEncoder = new TextEncoder();

const ANSI_CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_OTHER_RE = /\x1b[()=>][\x20-\x7E]?/g;
const SPINNER_RE = /[✻✶✢✽✤⊕●◯◉◐◑◒◓◔◕◖◗◘◙◚◛○◌◍◎★☆※❀❄☘♪♫♬♭♮♯⏳⌛⏵⎿⨯☐☑☒➤▶◀▲▼◢◣◤◥]/g;
const CTRL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;

export type G2Status = "idle" | "busy" | "streaming" | "stuck" | "error" | "reconnecting";

export type RenderInput = {
  slot: Slot;
  state: G2Status;
  assistantText: string;
  label?: string;
  footerMessage?: string;
  historyOffset?: number;
  now?: Date;
};

export type BridgeLike = {
  createStartUpPageContainer?: (payload: unknown) => Promise<unknown>;
  textContainerUpgrade: (payload: unknown) => Promise<unknown>;
};

export type GlassesRendererOptions = {
  bridge: BridgeLike;
  label?: string;
  debounceMs?: number;
  maxBodyChars?: number;
  maxBodyBytes?: number;
};

type TextContainerDefinition = {
  id: number;
  name: string;
  xPosition: number;
  yPosition: number;
  width: number;
  height: number;
  borderWidth?: number;
  borderColor?: number;
  borderRdaius?: number;
  isEventCapture: 0 | 1;
};

const CONTAINERS = {
  header: { id: 1, name: "g2-header", xPosition: 4, yPosition: 6, width: 568, height: 28, borderWidth: 1, borderColor: 6, isEventCapture: 0 },
  body: { id: 2, name: "g2-body", xPosition: 4, yPosition: 38, width: 568, height: 196, borderWidth: 1, borderColor: 6, isEventCapture: 1 },
  footer: { id: 3, name: "g2-footer", xPosition: 4, yPosition: 240, width: 568, height: 32, borderWidth: 1, borderColor: 6, isEventCapture: 0 },
} as const satisfies Record<string, TextContainerDefinition>;

const UPGRADABLE_CONTAINERS = [CONTAINERS.header, CONTAINERS.body, CONTAINERS.footer] as const;

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

export function cleanChunk(raw: string): string {
  return raw
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_OTHER_RE, "")
    .replace(SPINNER_RE, "")
    .replace(CTRL_RE, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function slidingUtf8Window(text: string, maxChars = 240, maxBytes = 720, maxLines = 7): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  const tail = lines.slice(-maxLines).join("\n");
  const chars = Array.from(tail);
  let out = "";
  let count = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (count >= maxChars) break;
    const next = chars[i] + out;
    if (utf8ByteLength(next) > maxBytes) break;
    out = next;
    count += 1;
  }
  return out.trimStart();
}

export function windowAtOffset(text: string, offsetChars: number, maxChars = 240, maxBytes = 720): string {
  const chars = Array.from(text.replace(/\r\n/g, "\n"));
  const maxOffset = Math.max(0, chars.length - maxChars);
  const offset = clamp(Math.trunc(offsetChars), 0, maxOffset);
  const end = chars.length - offset;
  const start = Math.max(0, end - maxChars);
  let out = "";
  let count = 0;

  for (let i = end - 1; i >= start; i -= 1) {
    if (count >= maxChars) break;
    const next = chars[i] + out;
    if (utf8ByteLength(next) > maxBytes) break;
    out = next;
    count += 1;
  }

  return out.trimStart();
}

export function buildG2FlatText(transcript: Turn[], assistantText: string): string {
  const parts: string[] = [];

  for (const turn of transcript) {
    if (turn.role === "user") {
      parts.push(formatUserTurn(turn.text));
    } else if (turn.status === "complete") {
      parts.push(turn.text);
    }
  }

  const latest = transcript.at(-1);
  if (assistantText && latest?.role === "assistant" && latest.status === "streaming") {
    parts.push(assistantText);
  }

  return parts.join("\n──\n");
}

export function createRenderSnapshot(input: RenderInput, maxBodyChars = 240, maxBodyBytes = 720) {
  const status = input.state === "busy" || input.state === "streaming" ? "*BUSY*" :
    input.state === "stuck" ? "STUCK" :
    input.state === "reconnecting" ? "RECONN" :
    input.state === "error" ? "ERR" : "idle";
  const time = formatTime(input.now || new Date());
  const body = slidingUtf8Window(cleanChunk(input.assistantText), maxBodyChars, maxBodyBytes);
  const footer = input.footerMessage || `[${input.slot}] ${input.state}`;
  const history = input.historyOffset && input.historyOffset > 0 ? ` ↑${input.historyOffset}` : "";
  const label = input.label || "g2";
  return {
    header: `${label}:${input.slot} ${status} ${time}${history}`,
    body: body || " ",
    footer,
  };
}

export class GlassesRenderer {
  private latest: RenderInput | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly bridge: BridgeLike;
  private readonly label: string;
  private readonly debounceMs: number;
  private readonly maxBodyChars: number;
  private readonly maxBodyBytes: number;

  constructor(options: GlassesRendererOptions) {
    this.bridge = options.bridge;
    this.label = options.label || "g2";
    this.debounceMs = options.debounceMs ?? 120;
    this.maxBodyChars = options.maxBodyChars ?? 240;
    this.maxBodyBytes = options.maxBodyBytes ?? 720;
  }

  async initialize(input: RenderInput) {
    this.latest = input;
    if (this.bridge.createStartUpPageContainer) {
      const snapshot = createRenderSnapshot({ ...input, label: input.label || this.label }, this.maxBodyChars, this.maxBodyBytes);
      await this.bridge.createStartUpPageContainer(createStartupPayload(snapshot));
    }
    await this.flush();
  }

  update(input: RenderInput) {
    this.latest = input;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  async flush() {
    if (!this.latest) return;
    const snapshot = createRenderSnapshot({ ...this.latest, label: this.latest.label || this.label }, this.maxBodyChars, this.maxBodyBytes);
    await this.bridge.textContainerUpgrade(createTextUpgrade(UPGRADABLE_CONTAINERS[0], snapshot.header));
    await this.bridge.textContainerUpgrade(createTextUpgrade(UPGRADABLE_CONTAINERS[1], snapshot.body));
    await this.bridge.textContainerUpgrade(createTextUpgrade(UPGRADABLE_CONTAINERS[2], snapshot.footer));
  }
}

function createStartupPayload(snapshot: { header: string; body: string; footer: string }) {
  return new sdkClasses.CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [
      createTextProperty(CONTAINERS.header, snapshot.header),
      createTextProperty(CONTAINERS.body, snapshot.body),
      createTextProperty(CONTAINERS.footer, snapshot.footer),
    ],
    listObject: [],
    imageObject: [],
  });
}

function createTextProperty(container: TextContainerDefinition, content: string) {
  return new sdkClasses.TextContainerProperty({
    xPosition: container.xPosition,
    yPosition: container.yPosition,
    width: container.width,
    height: container.height,
    borderWidth: container.borderWidth,
    borderColor: container.borderColor,
    borderRdaius: container.borderRdaius,
    containerID: container.id,
    containerName: container.name,
    isEventCapture: container.isEventCapture,
    content,
  });
}

function createTextUpgrade(container: TextContainerDefinition, content: string) {
  return new sdkClasses.TextContainerUpgrade({
    containerID: container.id,
    containerName: container.name,
    contentOffset: 0,
    contentLength: content.length,
    content,
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  });
}

function formatUserTurn(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
