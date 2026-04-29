import type { StatusIndicator } from "@pane-on-g2/shared/protocol";

const SPINNER = [".", "..", "..."];

export function formatStatusIndicator(status: StatusIndicator, frame = 0): string {
  const seconds = Math.floor(status.elapsedMs / 1000);
  if (status.state === "idle") return "idle";
  if (status.state === "stuck") return `stuck ${seconds}s`;
  const spinner = SPINNER[Math.abs(frame) % SPINNER.length];
  const tokens = typeof status.tokenCount === "number" ? ` ${status.tokenCount}tok` : "";
  return `busy${spinner} ${seconds}s${tokens}`;
}
