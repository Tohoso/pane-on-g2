import type { Slot } from "@pane-on-g2/shared/protocol";
import type { EventBroker, NumberedEvent } from "./stream.ts";

export function getResumeCursor(request: Request): string | null {
  const url = new URL(request.url);
  return request.headers.get("last-event-id") || url.searchParams.get("since") || url.searchParams.get("cursor");
}

export function replayForReconnect(broker: EventBroker, request: Request, slot?: Slot): NumberedEvent[] {
  return broker.replayAfter(getResumeCursor(request), slot);
}
