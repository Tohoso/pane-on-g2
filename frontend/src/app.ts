import "./style.css";
import type { Slot, PromptRequest, RingReplyGesture } from "./types";
import { SLOTS, isSlot } from "./types";
import { AudioController, bindAudioLifecycle, createPcmUploader, type AudioBridge } from "./audio";
import { bindBackgroundLifecycle } from "./background";
import { BleRecoveryController, type BleRecoveryBridge } from "./ble-recovery";
import { GlassesRenderer, buildG2FlatText, windowAtOffset, type BridgeLike } from "./glasses";
import { handleRingReply, RING_REPLY_PRESETS } from "./ring-replies";
import { formatSlotSelector, SLOT_SELECTOR_OPTIONS } from "./slot-selector";
import { EventStream } from "./stream";
import { bindTempleEvents as bindTempleHubEvents, cycleSlot as nextTempleSlot } from "./temple";
import { bindTranscriptUserScrollTracker, renderTranscript } from "./transcript-render";
import {
  activeSlotSnapshot,
  createInitialSlotState,
  transitionSlotState,
  type MultiSlotState,
  type SlotSnapshot,
} from "./slot-state";
import { formatStatusIndicator } from "./status-indicator";

// Runtime config priority: localStorage > cookie > build-time env > defaults.
// Even App's WebView may use a non-persistent storage partition, so we write
// to BOTH localStorage and an HTTP cookie (1-year max-age) and read from
// either one on launch. Cookies survive WKWebView restarts that clear LS.
const STORAGE_KEY = "pane-on-g2.config.v1";
const COOKIE_KEY = "pane_on_g2_config_v1";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
type RuntimeConfig = { apiBase: string; token: string; label: string };

function readLocalStorage(): Partial<RuntimeConfig> | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Partial<RuntimeConfig> : null;
  } catch { return null; }
}
function readCookie(): Partial<RuntimeConfig> | null {
  try {
    const raw = (globalThis.document?.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE_KEY}=`));
    if (!raw) return null;
    const value = decodeURIComponent(raw.slice(COOKIE_KEY.length + 1));
    return JSON.parse(value) as Partial<RuntimeConfig>;
  } catch { return null; }
}
function loadStoredConfig(): Partial<RuntimeConfig> {
  return readLocalStorage() ?? readCookie() ?? {};
}
function saveStoredConfig(cfg: RuntimeConfig): void {
  const json = JSON.stringify(cfg);
  try { globalThis.localStorage?.setItem(STORAGE_KEY, json); } catch { /* unavailable */ }
  try {
    if (globalThis.document) {
      globalThis.document.cookie = `${COOKIE_KEY}=${encodeURIComponent(json)}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
    }
  } catch { /* cookie write blocked */ }
}
function clearStoredConfig(): void {
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* unavailable */ }
  try {
    if (globalThis.document) {
      globalThis.document.cookie = `${COOKIE_KEY}=; path=/; max-age=0`;
    }
  } catch { /* unavailable */ }
}
const stored = loadStoredConfig();
const apiBase = stored.apiBase ?? import.meta.env.VITE_PANE_ON_G2_API_BASE ?? "";
let token = stored.token ?? import.meta.env.VITE_PANE_ON_G2_TOKEN ?? "";
const appLabel = stored.label ?? import.meta.env.VITE_PANE_ON_G2_LABEL ?? "g2";
const app = document.querySelector<HTMLDivElement>("#app");
const G2_BODY_CHARS = 240;
const G2_SCROLL_STEP_CHARS = 50;

if (!app) throw new Error("#app missing");

let state: MultiSlotState = createInitialSlotState();
let renderer: GlassesRenderer | null = null;
let stream: EventStream | null = null;
let audioController: AudioController | null = null;
let lastEventIdBySlot: Partial<Record<Slot, string>> = {};
let inReplay = true;
const recentOptimisticPrompts = new Map<string, number>();
const OPTIMISTIC_DEDUPE_MS = 8_000;
function isDuplicateOptimistic(slot: Slot, text: string): boolean {
  const key = `${slot}::${text.trim()}`;
  const ts = recentOptimisticPrompts.get(key);
  if (!ts) return false;
  if (Date.now() - ts > OPTIMISTIC_DEDUPE_MS) {
    recentOptimisticPrompts.delete(key);
    return false;
  }
  recentOptimisticPrompts.delete(key);
  return true;
}
let statusFrame = 0;
const sourceFilters: Record<"discord" | "tmux", boolean> = { discord: true, tmux: true };

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Even G2</p>
        <h1 id="title">${appLabel}:cc</h1>
      </div>
      <div class="topbar-actions">
        <span id="status" class="status">idle</span>
        <button id="settings-btn" class="settings-btn" type="button" aria-label="settings">⚙</button>
      </div>
    </header>

    <nav id="slot-selector" class="slot-selector" aria-label="slots"></nav>

    <div id="source-filters" class="source-filters" aria-label="source filters">
      <label><input type="checkbox" data-source="discord" checked /> Show Discord turns</label>
      <label><input type="checkbox" data-source="tmux" checked /> Show tmux turns</label>
    </div>

    <div id="audio-indicator" class="audio-indicator" hidden aria-live="polite">● recording</div>

    <div id="debug-hud" class="debug-hud" aria-label="debug" hidden>temple: — / audio: idle</div>

    <section class="transcript-log" aria-label="conversation history">
      <ol id="transcript" class="transcript-list"></ol>
    </section>

    <div id="ring-replies" class="ring-replies"></div>

    <form id="prompt-form" class="prompt">
      <textarea id="prompt-text" rows="3" placeholder="Send text to the selected slot"></textarea>
      <button type="submit">Send</button>
    </form>

    <dialog id="settings-modal" class="settings-modal">
      <form id="settings-form" method="dialog" class="settings-form">
        <h2>Server settings</h2>
        <p class="settings-hint">Point this app at your self-hosted pane-on-g2 server. Stored in your device's localStorage.</p>
        <label>API base URL
          <input id="settings-api" type="url" required placeholder="http://100.x.x.x:3457" />
        </label>
        <label>Bearer token
          <input id="settings-token" type="text" required placeholder="64-char hex from .env.prod" autocomplete="off" />
        </label>
        <label>Display label
          <input id="settings-label" type="text" placeholder="g2" />
        </label>
        <div class="settings-actions">
          <button type="button" id="settings-cancel" class="settings-cancel">Cancel</button>
          <button type="submit" id="settings-save" class="settings-save">Save & reload</button>
        </div>
      </form>
    </dialog>
  </main>
`;

const titleEl = document.querySelector<HTMLHeadingElement>("#title")!;
const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const slotSelectorEl = document.querySelector<HTMLElement>("#slot-selector")!;
const transcriptLogEl = document.querySelector<HTMLElement>(".transcript-log")!;
const transcriptEl = document.querySelector<HTMLOListElement>("#transcript")!;
const ringRepliesEl = document.querySelector<HTMLElement>("#ring-replies")!;
const sourceFiltersEl = document.querySelector<HTMLElement>("#source-filters")!;
const audioIndicatorEl = document.querySelector<HTMLElement>("#audio-indicator")!;
const debugHudEl = document.querySelector<HTMLElement>("#debug-hud")!;
const settingsBtnEl = document.querySelector<HTMLButtonElement>("#settings-btn")!;
const settingsModalEl = document.querySelector<HTMLDialogElement>("#settings-modal")!;
const settingsFormEl = document.querySelector<HTMLFormElement>("#settings-form")!;
const settingsApiEl = document.querySelector<HTMLInputElement>("#settings-api")!;
const settingsTokenEl = document.querySelector<HTMLInputElement>("#settings-token")!;
const settingsLabelEl = document.querySelector<HTMLInputElement>("#settings-label")!;
const settingsCancelEl = document.querySelector<HTMLButtonElement>("#settings-cancel")!;
function openSettingsModal() {
  settingsApiEl.value = apiBase;
  settingsTokenEl.value = token;
  settingsLabelEl.value = appLabel;
  settingsModalEl.showModal?.();
}
settingsBtnEl.addEventListener("click", openSettingsModal);
settingsCancelEl.addEventListener("click", () => settingsModalEl.close?.());
settingsFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  saveStoredConfig({
    apiBase: settingsApiEl.value.trim().replace(/\/+$/, ""),
    token: settingsTokenEl.value.trim(),
    label: (settingsLabelEl.value.trim() || "g2"),
  });
  globalThis.location?.reload?.();
});
// First-launch prompt: if no token configured, force the modal open before boot.
if (!token || token === "dev-token") {
  queueMicrotask(() => openSettingsModal());
}
const transcriptScrollTracker = bindTranscriptUserScrollTracker(transcriptLogEl);
const debugLog: string[] = [];
function setDebug(entry?: string) {
  if (entry) {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false }).slice(-5);
    debugLog.unshift(`${ts} ${entry}`);
    if (debugLog.length > 5) debugLog.length = 5;
  }
  const audioState = audioController?.state || "idle";
  const audioErr = audioController?.error ? ` err=${audioController.error.slice(0, 40)}` : "";
  debugHudEl.textContent = `audio: ${audioState}${audioErr} | ${debugLog.join(" / ") || "(no events yet)"}`;
}
const form = document.querySelector<HTMLFormElement>("#prompt-form")!;
const textarea = document.querySelector<HTMLTextAreaElement>("#prompt-text")!;

void boot();
setInterval(() => {
  const active = activeSlotSnapshot(state);
  if (active.status === "busy" || active.status === "streaming" || active.status === "stuck") render();
}, 1_000);

async function boot() {
  const bridge = await initBridge();
  renderer = new GlassesRenderer({ bridge, label: appLabel });
  await renderer.initialize({ slot: state.activeSlot, state: "idle", assistantText: "" });

  const audioBridge = toAudioBridge(bridge);
  const bleRecovery = new BleRecoveryController({
    bridge: bridge as BleRecoveryBridge,
    onStateChange(next) {
      if (next === "disconnected" || next === "reconnecting") {
        state = transitionSlotState(state, { type: "disconnect", ts: Date.now() });
      } else {
        state = transitionSlotState(state, { type: "reconnect", ts: Date.now() });
      }
      render();
    },
  });
  bleRecovery.start();
  const background = bindBackgroundLifecycle(bridge, {
    snapshot: () => ({ activeSlot: state.activeSlot, lastEventIdBySlot }),
    restore(snapshot) {
      const restored = snapshot as { activeSlot?: Slot; lastEventIdBySlot?: Partial<Record<Slot, string>> };
      if (restored.lastEventIdBySlot) lastEventIdBySlot = restored.lastEventIdBySlot;
      if (restored.activeSlot && isSlot(restored.activeSlot)) {
        state = transitionSlotState(state, { type: "slot_select", slot: restored.activeSlot, ts: Date.now() });
        connectStream(restored.activeSlot);
      }
      render();
    },
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void background.persist();
  });
  audioController = new AudioController({
    bridge: audioBridge,
    getSlot: () => state.activeSlot,
    uploadPcm: createPcmUploader({ apiBase, token, deviceId: "even-webview" }),
  });
  audioController.onStateChange(() => { setDebug(); render(); });
  bindAudioLifecycle(audioBridge, audioController);
  bindRingEvents(bridge);
  bindTempleEvents(bridge);
  bindForceExitEvents(bridge);
  bindSourceFilters();

  renderSlotControls();
  renderRingControls();
  connectStream(state.activeSlot);
}

function connectStream(slot: Slot) {
  stream?.close();
  inReplay = true;
  stream = new EventStream({
    url: `${apiBase}/api/events`,
    token,
    slot,
    initialLastEventId: lastEventIdBySlot[slot],
    onEvent(event) {
      if (event.type === "user_prompt" && !inReplay && isDuplicateOptimistic(event.slot, event.text)) return;
      state = transitionSlotState(state, event);
      if (!inReplay) render();
    },
    onCursor(id) {
      lastEventIdBySlot[slot] = id;
    },
    onReplayDone() {
      inReplay = false;
      render();
    },
    onDisconnect() {
      state = transitionSlotState(state, { type: "disconnect", ts: Date.now() });
      render();
    },
    onReconnect() {
      state = transitionSlotState(state, { type: "reconnect", ts: Date.now() });
      render();
    },
  });
  stream.connect();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = textarea.value.trim();
  if (!text) {
    setSlotError(state.activeSlot, "Text is empty");
    render();
    return;
  }

  try {
    await postPrompt({
      slot: state.activeSlot,
      text,
      source: "g2_text",
      requestId: (crypto.randomUUID && crypto.randomUUID()) || `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    textarea.value = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSlotError(state.activeSlot, `Send failed: ${message}`);
    render();
  }
});

async function postPrompt(request: PromptRequest) {
  recentOptimisticPrompts.set(`${request.slot}::${request.text.trim()}`, Date.now());
  state = transitionSlotState(state, {
    type: "user_prompt",
    slot: request.slot,
    text: request.text,
    source: request.source,
    ts: Date.now(),
  });
  render();
  const response = await fetch(`${apiBase}/api/prompt`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "x-pane-on-g2-device-id": "even-webview",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }));
    setSlotError(request.slot, body.message || "prompt failed");
    render();
    return;
  }

  if (request.source === "g2_text") textarea.value = "";
}

async function interruptSlot(slot: Slot) {
  const response = await fetch(`${apiBase}/api/interrupt`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "x-pane-on-g2-device-id": "even-webview",
    },
    body: JSON.stringify({ slot }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }));
    setSlotError(slot, body.message || "interrupt failed");
  }
  render();
}

function selectSlot(slot: Slot) {
  if (slot === state.activeSlot) return;
  state = transitionSlotState(state, { type: "slot_select", slot, ts: Date.now() });
  connectStream(slot);
  renderSlotControls();
  render();
}

function cycleSlot() {
  selectSlot(nextTempleSlot(state.activeSlot));
}

function render() {
  const active = activeSlotSnapshot(state);
  const g2Body = renderG2Body(active);
  titleEl.textContent = `${appLabel}:${state.activeSlot}`;
  statusEl.textContent = renderStatus(active);
  slotSelectorEl.setAttribute("aria-label", formatSlotSelector(state.activeSlot, slotStatuses()));
  renderAudioIndicator();
  renderTranscript({
    transcriptLogEl,
    transcriptEl,
    transcript: active.transcript,
    sourceFilters,
    userIsScrolling: transcriptScrollTracker.isUserScrolling(),
    isUserScrolling: transcriptScrollTracker.isUserScrolling,
  });
  renderer?.update({
    slot: state.activeSlot,
    state: active.status,
    assistantText: g2Body.text,
    footerMessage: renderFooter(active),
    historyOffset: g2Body.historyOffset,
  });
}

function renderG2Body(active: SlotSnapshot): { text: string; historyOffset: number } {
  // Single source of truth: the current pane snapshot (last 200 lines of tmux
  // capture-pane). Both live mode (offset=0) and history scroll (offset>0)
  // window into the SAME text so 1 swipe = N chars feels predictable instead
  // of teleporting between the live pane and the JSONL-derived turn archive.
  const source = active.paneSnapshot.trim()
    ? active.paneSnapshot
    : active.assistantText
      ? active.assistantText
      : (() => {
          const lastUser = [...active.transcript].reverse().find((turn) => turn.role === "user");
          return lastUser ? `→ ${lastUser.text}` : "";
        })();

  if (active.g2HistoryOffset <= 0) {
    return { text: source, historyOffset: 0 };
  }

  const maxOffset = Math.max(0, Array.from(source).length - G2_BODY_CHARS);
  const historyOffset = clamp(active.g2HistoryOffset, 0, maxOffset);
  return {
    text: windowAtOffset(source, historyOffset, G2_BODY_CHARS),
    historyOffset,
  };
}

function renderStatus(active: SlotSnapshot): string {
  const indicatorState = active.status === "stuck" ? "stuck" :
    active.status === "busy" || active.status === "streaming" ? "busy" : "idle";
  const elapsedMs = indicatorState === "idle" || !active.lastEventAt ? 0 : Date.now() - active.lastEventAt;
  return formatStatusIndicator({ state: indicatorState, elapsedMs }, statusFrame++);
}

function renderSlotControls() {
  slotSelectorEl.innerHTML = "";
  for (const slot of SLOT_SELECTOR_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot-button";
    button.dataset.active = String(slot === state.activeSlot);
    button.textContent = slot;
    button.addEventListener("click", () => selectSlot(slot));
    slotSelectorEl.append(button);
  }
}

function renderAudioIndicator() {
  const recording = audioController?.state === "recording";
  audioIndicatorEl.hidden = !recording;
  audioIndicatorEl.textContent = recording ? "● recording" : "";
}

function renderFooter(active: SlotSnapshot): string {
  if (active.error) return active.error;
  if (audioController?.state === "recording") return `[${state.activeSlot}] audio recording`;
  if (audioController?.state === "uploading") return `[${state.activeSlot}] audio uploading`;
  return `[${state.activeSlot}] ${active.status}`;
}

function renderRingControls() {
  ringRepliesEl.innerHTML = "";
  for (const gesture of Object.keys(RING_REPLY_PRESETS) as RingReplyGesture[]) {
    const preset = RING_REPLY_PRESETS[gesture];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ring-button";
    button.textContent = preset.text;
    button.addEventListener("click", () => {
      void handleRingReply(gesture, {
        activeSlot: () => state.activeSlot,
        postPrompt,
        interrupt: interruptSlot,
      });
    });
    ringRepliesEl.append(button);
  }
}

function bindSourceFilters() {
  sourceFiltersEl.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target?.dataset.source === "discord" || target?.dataset.source === "tmux") {
      sourceFilters[target.dataset.source] = target.checked;
      render();
    }
  });
}

function slotStatuses(): Record<Slot, SlotSnapshot["status"]> {
  return Object.fromEntries(SLOTS.map((slot) => [slot, state.slots[slot].status])) as Record<Slot, SlotSnapshot["status"]>;
}

function setSlotError(slot: Slot, error: string) {
  state = {
    ...state,
    slots: {
      ...state.slots,
      [slot]: {
        ...state.slots[slot],
        status: "error",
        error,
      },
    },
  };
}

function shiftG2History(delta: number) {
  const active = state.slots[state.activeSlot];
  const maxOffset = computeMaxOffset(active);
  const currentOffset = clamp(active.g2HistoryOffset, 0, maxOffset);
  const nextOffset = clamp(currentOffset + delta, 0, maxOffset);
  state = {
    ...state,
    slots: {
      ...state.slots,
      [state.activeSlot]: {
        ...active,
        g2HistoryOffset: nextOffset,
      },
    },
  };
  render();
  // If user tried to scroll past a boundary (offset clamped, no actual change),
  // force a fresh G2 page rebuild so the firmware's internal text-container
  // auto-scroll resets to top of our content. Without this, swiping past the
  // bottom boundary makes the firmware snap the visible window back to char 0.
  if (nextOffset === currentOffset) {
    void renderer?.initialize({
      slot: state.activeSlot,
      state: activeSlotSnapshot(state).status,
      assistantText: renderG2Body(activeSlotSnapshot(state)).text,
      footerMessage: renderFooter(activeSlotSnapshot(state)),
      historyOffset: nextOffset,
    });
  }
}

function computeMaxOffset(slot = state.slots[state.activeSlot]): number {
  const source = slot.paneSnapshot || slot.assistantText || "";
  const len = Array.from(source).length;
  return Math.max(0, len - G2_BODY_CHARS);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type CompanionBridge = BridgeLike & Partial<AudioBridge> & BleRecoveryBridge & {
  setBackgroundState?: (state: unknown) => void | Promise<void>;
  onBackgroundRestore?: (handler: (state: unknown) => void) => void;
  onEvenHubEvent?: (handler: (event: unknown) => void) => unknown;
  on?: (handler: (event: unknown) => void) => unknown;
};

function bindRingEvents(bridge: CompanionBridge) {
  const on = bridge.onEvent || bridge.addEventListener;
  if (!on) return;
  const bind = (eventName: string, gesture: RingReplyGesture) => {
    on.call(bridge, eventName, () => {
      void handleRingReply(gesture, {
        activeSlot: () => state.activeSlot,
        postPrompt,
        interrupt: interruptSlot,
      });
    });
  };
  bind("r1_single_tap", "single_tap");
  bind("r1_double_tap", "double_tap");
  bind("r1_long_press", "long_press");
  bind("r1_triple_tap", "triple_tap");
}

function bindForceExitEvents(bridge: CompanionBridge) {
  const on = bridge.onEvent || bridge.addEventListener;
  if (!on) return;
  const forceExit = () => {
    stream?.close();
    stream = null;
    void audioController?.cancel();
    state = transitionSlotState(state, { type: "disconnect", ts: Date.now() });
    render();
  };
  on.call(bridge, "force_exit", forceExit);
}

function bindTempleEvents(bridge: CompanionBridge) {
  bridge.onEvenHubEvent?.((event: any) => {
    const ev = event?.textEvent || event?.listEvent || event?.sysEvent;
    const audio = event?.audioEvent ? "[audio]" : "";
    setDebug(`type=${ev?.eventType ?? "?"} src=${event?.textEvent ? "text" : event?.listEvent ? "list" : event?.sysEvent ? "sys" : "?"}${audio}`);
  });
  bindTempleHubEvents(bridge, {
    onSingleTap: () => { setDebug("single→toggleAudio"); toggleAudio(); },
    onDoubleTap: () => { setDebug("double→cycleSlot"); cycleSlot(); },
    onScrollUp: () => {
      setDebug("scrollUp");
      shiftG2History(G2_SCROLL_STEP_CHARS);
      requestAnimationFrame(() => transcriptLogEl.scrollBy({ top: -120, behavior: "smooth" }));
    },
    onScrollDown: () => {
      setDebug("scrollDown");
      shiftG2History(-G2_SCROLL_STEP_CHARS);
      requestAnimationFrame(() => transcriptLogEl.scrollBy({ top: 120, behavior: "smooth" }));
    },
  });
}

function toggleAudio() {
  if (!audioController) return;
  void audioController.toggle().then((result) => {
    if (result && "ok" in result && result.ok && result.transcribed) {
      const slot = state.activeSlot;
      recentOptimisticPrompts.set(`${slot}::${result.transcribed.trim()}`, Date.now());
      state = transitionSlotState(state, {
        type: "user_prompt",
        slot,
        text: result.transcribed,
        source: "g2_voice",
        ts: Date.now(),
      });
      render();
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setSlotError(state.activeSlot, `Audio failed: ${message}`);
    render();
  });
}

function toAudioBridge(bridge: CompanionBridge): AudioBridge {
  const onAudio = bridge.onAudio?.bind(bridge) || ((handler: (event: { audioPcm?: Uint8Array }) => void) => {
    bridge.onEvenHubEvent?.((event: any) => {
      const payload = event?.audioEvent;
      if (!payload) return;
      const raw = payload.audioPcm;
      if (!raw) return;
      const pcm = raw instanceof Uint8Array
        ? raw
        : Array.isArray(raw)
          ? new Uint8Array(raw)
          : typeof raw === "string"
            ? base64ToUint8(raw)
            : null;
      if (pcm) handler({ audioPcm: pcm });
    });
  });
  return {
    audioControl: bridge.audioControl?.bind(bridge) || (async (enabled: boolean) => {
      console.debug("[mock-g2] audioControl", enabled);
    }),
    onEvent: bridge.onEvent?.bind(bridge),
    addEventListener: bridge.addEventListener?.bind(bridge),
    onAudio,
  };
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function initBridge(): Promise<CompanionBridge> {
  try {
    const sdk = await import("@evenrealities/even_hub_sdk");
    const bridge = await Promise.race([
      sdk.waitForEvenAppBridge(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge timeout")), 4_000)),
    ]);
    return bridge as unknown as CompanionBridge;
  } catch {
    return {
      async createStartUpPageContainer(payload: unknown) {
        console.debug("[mock-g2] startup", payload);
      },
      async textContainerUpgrade(payload: unknown) {
        console.debug("[mock-g2] upgrade", payload);
      },
      async audioControl(enabled: boolean) {
        console.debug("[mock-g2] audioControl", enabled);
      },
    };
  }
}
