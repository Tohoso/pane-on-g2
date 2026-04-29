import type { Slot } from "./types";
import { SLOTS } from "./types";

type TempleBridge = {
  onEvenHubEvent?: (handler: (event: unknown) => void) => unknown;
  on?: (handler: (event: unknown) => void) => unknown;
};

export type TempleHandlers = {
  onSingleTap?: () => void;
  onDoubleTap?: () => void;
  onScrollUp?: () => void;
  onScrollDown?: () => void;
};

const CLICK_EVENT = 0;
const SCROLL_TOP_EVENT = 1;
const SCROLL_BOTTOM_EVENT = 2;
const DOUBLE_CLICK_EVENT = 3;

export function cycleSlot(activeSlot: Slot, order: readonly Slot[] = SLOTS): Slot {
  const idx = order.indexOf(activeSlot);
  return order[(idx + 1) % order.length];
}

export function bindTempleEvents(bridge: TempleBridge, handlers: TempleHandlers) {
  const onHubEvent = bridge.onEvenHubEvent || bridge.on?.bind?.(bridge);
  if (!onHubEvent) return;

  let pendingSingleTap: ReturnType<typeof setTimeout> | null = null;
  const cancelPendingSingle = () => {
    if (pendingSingleTap) {
      clearTimeout(pendingSingleTap);
      pendingSingleTap = null;
    }
  };
  let lastScrollAt = 0;
  const SCROLL_DEBOUNCE_MS = 350;
  const debouncedScroll = (handler?: () => void) => {
    const now = Date.now();
    if (now - lastScrollAt < SCROLL_DEBOUNCE_MS) return;
    lastScrollAt = now;
    handler?.();
  };
  onHubEvent.call(bridge, (event: any) => {
    const ev = event?.textEvent || event?.listEvent || event?.sysEvent;
    if (!ev) return;
    if (event?.sysEvent && ev.eventType >= 4) return;
    if (ev.eventType === CLICK_EVENT || ev.eventType === undefined) {
      cancelPendingSingle();
      pendingSingleTap = setTimeout(() => {
        pendingSingleTap = null;
        handlers.onSingleTap?.();
      }, 260);
    } else if (ev.eventType === DOUBLE_CLICK_EVENT) {
      cancelPendingSingle();
      handlers.onDoubleTap?.();
    } else if (ev.eventType === SCROLL_TOP_EVENT) {
      cancelPendingSingle();
      debouncedScroll(handlers.onScrollUp);
    } else if (ev.eventType === SCROLL_BOTTOM_EVENT) {
      cancelPendingSingle();
      debouncedScroll(handlers.onScrollDown);
    }
  });
}
