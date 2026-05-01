// capture.mjs — opens a headed Chromium, lets the user manually publish,
// then dumps every captured request/response (URL, method, headers, body)
// to tools/dev-portal/captured-traffic.json.
//
// Use this once to reverse-engineer the Dev Portal upload API. After that,
// the curl-based publish.mjs replays the same calls headlessly with the
// saved auth state.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const STATE = path.join(ROOT, ".dev-portal-state.json");
const OUT = path.join(ROOT, "tools/dev-portal/captured-traffic.json");

const events = [];
const startedAt = Date.now();
let captureCount = 0;

function persist() {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error("Failed to persist:", err.message);
  }
}

const persistInterval = setInterval(persist, 1000);
process.on("SIGINT", () => { persist(); process.exit(0); });
process.on("SIGTERM", () => { persist(); process.exit(0); });

const launchOpts = { headless: false };
const ctxOpts = { viewport: null };
if (fs.existsSync(STATE)) ctxOpts.storageState = STATE;

const browser = await chromium.launch(launchOpts);
const context = await browser.newContext(ctxOpts);

context.on("request", (req) => {
  const url = req.url();
  // capture only Dev Portal traffic, skip noise (CDN, fonts, GA, etc.)
  if (!/hub\.evenrealities\.com|evenhub\.evenrealities\.com/.test(url)) return;
  if (/\.(svg|png|jpg|jpeg|woff2?|css|ico|webp)(\?|$)/i.test(url)) return;
  events.push({
    t: Date.now() - startedAt,
    direction: "request",
    method: req.method(),
    url,
    resourceType: req.resourceType(),
    headers: req.headers(),
    postData: req.postData()?.slice(0, 8192),
  });
  captureCount += 1;
  process.stdout.write(`\r[${captureCount} events] ${req.method()} ${url.slice(-60)}              `);
});

context.on("response", async (res) => {
  const url = res.url();
  if (!/hub\.evenrealities\.com|evenhub\.evenrealities\.com/.test(url)) return;
  if (/\.(svg|png|jpg|jpeg|woff2?|css|ico|webp)(\?|$)/i.test(url)) return;
  let body;
  try {
    const text = await res.text();
    body = text.slice(0, 8192);
  } catch { /* binary or non-text */ }
  events.push({
    t: Date.now() - startedAt,
    direction: "response",
    status: res.status(),
    url,
    headers: res.headers(),
    body,
  });
});

const page = await context.newPage();
await page.goto("https://hub.evenrealities.com/hub");

console.log("\n=========================================================");
console.log(" Dev Portal traffic capture started.");
console.log(" Manually upload your .ehpk and flip status to Beta.");
console.log(" When you're done, close the browser window to save.");
console.log("=========================================================\n");

// Block until the user closes the browser
await new Promise((resolve) => browser.on("disconnected", resolve));

clearInterval(persistInterval);
persist();
console.log(`\nSaved ${events.length} events to ${OUT}`);
process.exit(0);
