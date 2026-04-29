function showBootError(prefix: string, message: string, stack?: string): void {
  const root = document.querySelector("#app");
  if (!root || root.innerHTML) return;
  const errorEl = document.createElement("pre");
  errorEl.style.cssText = "color:#ff6b6b;padding:16px;font-family:monospace;white-space:pre-wrap;";
  errorEl.textContent = `${prefix}: ${message}${stack ? `\n${stack}` : ""}`;
  root.replaceChildren(errorEl);
}

window.addEventListener("error", (event) => {
  showBootError("UI error", event.message, event.error?.stack);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  showBootError("UI promise error", reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? reason.stack : undefined);
});

void import("./app").catch((error) => {
  showBootError("UI import error", error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
});
