import { chromium } from "playwright";
const STATE = "/srv/ayu-workspace/projects/pane-on-g2/.dev-portal-state.json";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE });
const page = await context.newPage();

page.on("console", m => console.log(`CONSOLE:${m.type()}:`, m.text().slice(0, 200)));
page.on("pageerror", e => console.log("PAGEERR:", e.message));

await page.goto("https://hub.evenrealities.com/hub", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(8000);

const lsKeys = await page.evaluate(() => Object.keys(localStorage));
console.log("\nlocalStorage keys after load:", lsKeys);
const body = await page.evaluate(() => document.body.innerText.slice(0, 300));
console.log("body text:", body);

await browser.close();
