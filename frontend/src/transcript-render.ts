import type { Turn, UserTurnSource } from "./types";

export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 8;
export const USER_SCROLL_IDLE_DELAY_MS = 250;

type SourceFilters = Record<"discord" | "tmux", boolean>;

const defaultSourceFilters: SourceFilters = { discord: true, tmux: true };

export type TranscriptRenderOptions = {
  transcriptLogEl: HTMLElement;
  transcriptEl: HTMLOListElement;
  transcript: Turn[];
  sourceFilters?: SourceFilters;
  userIsScrolling?: boolean;
  isUserScrolling?: () => boolean;
};

const lastScrollHeightByEl = new WeakMap<HTMLElement, number>();

export type TranscriptScrollDecision = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  thresholdPx?: number;
};

export function decideTranscriptScrollTop({
  scrollTop,
  scrollHeight,
  clientHeight,
  thresholdPx = TRANSCRIPT_BOTTOM_THRESHOLD_PX,
}: TranscriptScrollDecision): number | null {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return maxScrollTop - scrollTop <= thresholdPx ? maxScrollTop : null;
}

export function bindTranscriptUserScrollTracker(
  transcriptLogEl: HTMLElement,
  idleDelayMs = USER_SCROLL_IDLE_DELAY_MS,
): { isUserScrolling: () => boolean; dispose: () => void } {
  let userIsScrolling = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const markActive = () => {
    userIsScrolling = true;
    clearIdleTimer();
  };
  const scheduleIdle = () => {
    userIsScrolling = true;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      userIsScrolling = false;
      idleTimer = null;
    }, idleDelayMs);
  };

  transcriptLogEl.addEventListener("touchstart", markActive, { passive: true });
  transcriptLogEl.addEventListener("touchend", scheduleIdle, { passive: true });
  transcriptLogEl.addEventListener("touchcancel", scheduleIdle, { passive: true });
  transcriptLogEl.addEventListener("wheel", scheduleIdle, { passive: true });

  return {
    isUserScrolling: () => userIsScrolling,
    dispose: () => {
      clearIdleTimer();
      transcriptLogEl.removeEventListener("touchstart", markActive);
      transcriptLogEl.removeEventListener("touchend", scheduleIdle);
      transcriptLogEl.removeEventListener("touchcancel", scheduleIdle);
      transcriptLogEl.removeEventListener("wheel", scheduleIdle);
    },
  };
}

export function renderTranscript({
  transcriptLogEl,
  transcriptEl,
  transcript,
  sourceFilters = defaultSourceFilters,
  userIsScrolling = false,
  isUserScrolling,
}: TranscriptRenderOptions): void {
  const wasNearBottom = !userIsScrolling && decideTranscriptScrollTop({
    scrollTop: transcriptLogEl.scrollTop,
    scrollHeight: transcriptLogEl.scrollHeight,
    clientHeight: transcriptLogEl.clientHeight,
  }) !== null;
  const prevHeight = lastScrollHeightByEl.get(transcriptLogEl);
  const isFirstRender = prevHeight === undefined;

  const visibleTurns = visibleTranscriptTurns(transcript, sourceFilters);
  const existing = new Map<string, HTMLLIElement>();
  for (const li of Array.from(transcriptEl.children) as HTMLLIElement[]) {
    const id = li.dataset.turnId;
    if (id) existing.set(id, li);
  }

  const wantedIds = new Set(visibleTurns.map((turn) => turn.id));
  for (const [id, li] of existing) {
    if (!wantedIds.has(id)) li.remove();
  }

  let cursor: Element | null = transcriptEl.firstElementChild;
  for (const turn of visibleTurns) {
    let li = existing.get(turn.id);
    if (li) {
      updateTurn(li, turn);
      if (cursor === li) {
        cursor = li.nextElementSibling;
      } else {
        transcriptEl.insertBefore(li, cursor);
      }
    } else {
      li = renderTurn(turn);
      transcriptEl.insertBefore(li, cursor);
    }
  }

  const newHeight = transcriptLogEl.scrollHeight;
  lastScrollHeightByEl.set(transcriptLogEl, newHeight);

  const heightGrew = isFirstRender || newHeight > (prevHeight ?? 0);
  if (wasNearBottom && heightGrew && !isUserScrolling?.()) {
    transcriptLogEl.scrollTop = Math.max(0, transcriptLogEl.scrollHeight - transcriptLogEl.clientHeight);
  }
}

function visibleTranscriptTurns(transcript: Turn[], sourceFilters: SourceFilters): Turn[] {
  const visibleTurns: Turn[] = [];
  let hideCurrentExchange = false;
  for (const turn of transcript) {
    if (turn.role === "user") {
      hideCurrentExchange = shouldHideSource(turn.source, sourceFilters);
      if (hideCurrentExchange) continue;
    } else if (hideCurrentExchange) {
      continue;
    }
    visibleTurns.push(turn);
  }
  return visibleTurns;
}

function shouldHideSource(source: UserTurnSource | undefined, sourceFilters: SourceFilters): boolean {
  return (source === "discord" || source === "tmux") && !sourceFilters[source];
}

function updateTurn(item: HTMLLIElement, turn: Turn): void {
  item.className = `turn turn--${turn.role}`;
  if (turn.role === "assistant" && turn.status === "streaming") item.classList.add("streaming");

  const text = item.querySelector<HTMLDivElement>(".turn-text");
  if (!text) return;
  const isStreaming = turn.role === "assistant" && turn.status === "streaming";
  const desired = turn.text || (isStreaming ? " " : "");
  const caret = text.querySelector(".streaming-caret");
  if (text.firstChild?.nodeType === Node.TEXT_NODE) {
    if ((text.firstChild as Text).data !== desired) (text.firstChild as Text).data = desired;
  } else {
    text.replaceChildren(document.createTextNode(desired));
  }
  if (isStreaming) {
    if (!caret) {
      const c = document.createElement("span");
      c.className = "streaming-caret";
      c.textContent = "▌";
      text.append(c);
    } else {
      text.append(caret);
    }
  } else if (caret) {
    caret.remove();
  }
}

function renderTurn(turn: Turn): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset.turnId = turn.id;
  item.className = `turn turn--${turn.role}`;
  if (turn.role === "assistant" && turn.status === "streaming") item.classList.add("streaming");

  const meta = document.createElement("div");
  meta.className = "turn-meta";

  const role = document.createElement("span");
  role.className = "turn-role";
  role.textContent = turn.role === "user" ? `user${turn.source ? ` · ${turn.source}` : ""}` : "assistant";

  const time = document.createElement("time");
  time.dateTime = new Date(turn.ts).toISOString();
  time.textContent = formatTurnTime(turn.ts);

  const text = document.createElement("div");
  text.className = "turn-text";
  text.textContent = turn.text || (turn.role === "assistant" && turn.status === "streaming" ? " " : "");

  if (turn.role === "assistant" && turn.status === "streaming") {
    const caret = document.createElement("span");
    caret.className = "streaming-caret";
    caret.textContent = "▌";
    text.append(caret);
  }

  meta.append(role, time);
  item.append(meta, text);
  return item;
}

function formatTurnTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
