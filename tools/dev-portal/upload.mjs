#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const BASE_URL = "https://hub.evenrealities.com";
export const STATE_PATH = path.resolve(process.cwd(), ".dev-portal-state.json");
export const EHPK_PATH = path.resolve(process.cwd(), "pane-on-g2.ehpk");
export const ERROR_SCREENSHOT_PATH = path.resolve(process.cwd(), "tools/dev-portal/last-error.png");

export function readAppJson(cwd = process.cwd(), fsImpl = fs) {
  const appPath = path.resolve(cwd, "app.json");
  const parsed = JSON.parse(fsImpl.readFileSync(appPath, "utf8"));

  if (typeof parsed.package_id !== "string" || parsed.package_id.trim() === "") {
    throw new Error(`app.json must contain a non-empty package_id: ${appPath}`);
  }

  return parsed;
}

export const APP_JSON = readAppJson(process.cwd());
export const PACKAGE_ID = APP_JSON.package_id;

export function usage() {
  return [
    "Usage:",
    "  node tools/dev-portal/upload.mjs login",
    "  node tools/dev-portal/upload.mjs publish",
    "  node tools/dev-portal/upload.mjs status",
    "",
  ].join("\n");
}

export async function loadPlaywright() {
  return import("playwright");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssAttrContains(value) {
  return value.replace(/["\\]/g, "\\$&");
}

function normalizeStatus(status) {
  if (!status) return null;
  if (/beta/i.test(status)) return "Beta";
  if (/private/i.test(status)) return "Private";
  if (/public/i.test(status)) return "Public";
  if (/draft/i.test(status)) return "Draft";
  return status;
}

function formatVersion(version) {
  if (!version) return "unknown";
  return version.startsWith("v") ? version : `v${version}`;
}

function isAuthUrl(value) {
  try {
    const url = new URL(value);
    return /^\/(?:login|register)\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function waitForLoadSettled(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
}

async function waitForFirstVisible(locators, { timeout = 10_000, description = "element" } = {}) {
  const errors = [];

  for (const locator of locators) {
    const first = locator.first();
    try {
      await first.waitFor({ state: "visible", timeout });
      return first;
    } catch (error) {
      errors.push(error);
    }
  }

  const last = errors.at(-1);
  throw new Error(`Could not find ${description}${last ? `: ${last.message}` : ""}`);
}

async function waitForFirstAttached(locators, { timeout = 20_000, description = "element" } = {}) {
  const errors = [];

  for (const locator of locators) {
    const first = locator.first();
    try {
      await first.waitFor({ state: "attached", timeout });
      return first;
    } catch (error) {
      errors.push(error);
    }
  }

  const last = errors.at(-1);
  throw new Error(`Could not find ${description}${last ? `: ${last.message}` : ""}`);
}

async function clickFirstVisible(locators, options = {}) {
  const locator = await waitForFirstVisible(locators, options);
  await locator.click();
  return locator;
}

async function maybeClickFirstVisible(locators, options = {}) {
  try {
    return await clickFirstVisible(locators, { timeout: 3_000, ...options });
  } catch {
    return null;
  }
}

export async function buildEhpk({ cwd = process.cwd(), runExecFile = execFile, stdout = process.stdout, stderr = process.stderr } = {}) {
  const result = await runExecFile("bash", ["scripts/ehpk.sh"], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result?.stdout) stdout.write(result.stdout);
  if (result?.stderr) stderr.write(result.stderr);
}

function newestInputMtimeMs(cwd, fsImpl = fs) {
  const roots = [
    "app.json",
    "pane-on-g2.config.json",
    "frontend/index.html",
    "frontend/package.json",
    "frontend/public",
    "frontend/src",
    "shared/src",
  ];

  let newest = 0;
  const visit = (target) => {
    if (!fsImpl.existsSync(target)) return;

    const stats = fsImpl.statSync(target);
    if (stats.mtimeMs > newest) newest = stats.mtimeMs;

    if (!stats.isDirectory()) return;
    for (const entry of fsImpl.readdirSync(target, { withFileTypes: true })) {
      visit(path.join(target, entry.name));
    }
  };

  for (const root of roots) visit(path.resolve(cwd, root));
  return newest;
}

function ehpkBuildReason({ cwd, ehpkPath, existsSync = fs.existsSync, fsImpl = fs }) {
  if (!existsSync(ehpkPath)) return `Missing ${path.relative(cwd, ehpkPath)}`;

  const ehpkMtimeMs = fsImpl.statSync(ehpkPath).mtimeMs;
  const inputMtimeMs = newestInputMtimeMs(cwd, fsImpl);
  if (inputMtimeMs > ehpkMtimeMs) return `${path.relative(cwd, ehpkPath)} is older than app inputs`;

  return null;
}

export async function ensureEhpk({
  cwd = process.cwd(),
  ehpkPath = EHPK_PATH,
  existsSync = fs.existsSync,
  fsImpl = fs,
  runBuild = buildEhpk,
  stdout = process.stdout,
} = {}) {
  const reason = ehpkBuildReason({ cwd, ehpkPath, existsSync, fsImpl });
  if (!reason) return false;

  stdout.write(`${reason}; building with scripts/ehpk.sh\n`);
  await runBuild({ cwd, stdout });

  if (!existsSync(ehpkPath)) {
    throw new Error(`scripts/ehpk.sh completed but ${ehpkPath} was not created`);
  }

  return true;
}

export async function waitForLoginLanding(page, { timeoutMs = 600_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isAuthUrl(page.url())) return;
    await page.waitForTimeout(intervalMs);
  }

  throw new Error("Timed out waiting for login to complete. Expected to leave /login or /register.");
}

async function newPlaywrightContext({ statePath, playwright, headless = true }) {
  const pw = playwright ?? (await loadPlaywright());
  const browser = await pw.chromium.launch({ headless });
  const context = await browser.newContext({ storageState: statePath });
  const page = await context.newPage();

  return { browser, context, page };
}

async function openAuthenticatedContext({
  baseUrl = BASE_URL,
  statePath = STATE_PATH,
  existsSync = fs.existsSync,
  playwright,
} = {}) {
  if (!existsSync(statePath)) {
    throw new Error(`Missing ${statePath}. Run: corepack pnpm run publish-login`);
  }

  const session = await newPlaywrightContext({ statePath, playwright });
  await session.page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForLoadSettled(session.page);

  if (isAuthUrl(session.page.url())) {
    throw new Error("Dev Portal redirected to login. Re-run: corepack pnpm run publish-login");
  }

  return session;
}

async function findAppEntry(page, { packageId = PACKAGE_ID, appName = APP_JSON.name }) {
  const packagePattern = new RegExp(escapeRegExp(packageId), "i");
  const appNamePattern = appName ? new RegExp(escapeRegExp(appName), "i") : null;

  const locators = [
    page.locator(`[href*="${cssAttrContains(packageId)}"]`),
    page.getByRole("link", { name: packagePattern }),
    page.getByRole("button", { name: packagePattern }),
    page.getByText(packageId, { exact: true }),
    page.getByText(packageId),
  ];

  if (appNamePattern) {
    locators.push(
      page.getByRole("link", { name: appNamePattern }),
      page.getByRole("button", { name: appNamePattern }),
      page.getByText(appName, { exact: true }),
    );
  }

  return waitForFirstVisible(locators, {
    timeout: 5_000,
    description: `app entry for package_id ${packageId}`,
  });
}

async function clickAppEntry(page, locator) {
  const link = locator.locator("xpath=ancestor-or-self::a[1]").first();
  try {
    await link.waitFor({ state: "visible", timeout: 1_000 });
    await link.click();
  } catch {
    await locator.click();
  }
  await waitForLoadSettled(page);
}

export async function openAppBuild(page, {
  baseUrl = BASE_URL,
  packageId = PACKAGE_ID,
  appName = APP_JSON.name,
} = {}) {
  const dashboardUrls = [`${baseUrl}/hub`, `${baseUrl}/hub/apps`, `${baseUrl}/hub/dashboard`];
  const errors = [];

  for (const url of dashboardUrls) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForLoadSettled(page);

    if (isAuthUrl(page.url())) {
      throw new Error("Dev Portal redirected to login. Re-run: corepack pnpm run publish-login");
    }

    try {
      const entry = await findAppEntry(page, { packageId, appName });
      await clickAppEntry(page, entry);
      return page.url();
    } catch (error) {
      errors.push(error);
    }
  }

  const message = errors.at(-1)?.message ?? "unknown error";
  throw new Error(`Could not locate Dev Portal app for package_id ${packageId}: ${message}`);
}

export async function readBuildDetails(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    const exactStatus = [...document.querySelectorAll("span,button,div,p,td,dd")]
      .map((element) => element.textContent?.trim() ?? "")
      .find((value) => /^(Beta|Private|Public|Draft|Review)$/i.test(value));
    const versionPatterns = [
      /(?:version|build)\s*[:#]?\s*v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/i,
      /\bv([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/i,
      /\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/,
    ];
    const statusMatch = text.match(/(?:status|visibility)\s*[:\n ]+\s*(Beta|Private|Public|Draft|Review)\b/i)
      ?? text.match(/\b(Beta|Private|Public|Draft|Review)\b/i);
    const testerMatch = text.match(/(\d+)\s*(?:beta\s*)?testers?\b/i);

    let version = null;
    for (const pattern of versionPatterns) {
      const match = text.match(pattern);
      if (match) {
        version = match[1];
        break;
      }
    }

    return {
      version,
      status: exactStatus ?? statusMatch?.[1] ?? null,
      testerCount: testerMatch ? Number(testerMatch[1]) : null,
    };
  });
}

export async function uploadEhpk(page, {
  ehpkPath = EHPK_PATH,
  expectedVersion = APP_JSON.version,
} = {}) {
  await maybeClickFirstVisible([
    page.getByRole("button", { name: /upload new version/i }),
    page.getByRole("button", { name: /upload/i }),
    page.getByText(/upload new version/i),
  ], {
    timeout: 5_000,
    description: "upload trigger",
  });

  await waitForFirstAttached([
    page.locator('input[type="file"][accept*=".ehpk"]'),
    page.locator('input[type="file"]'),
  ], {
    timeout: 20_000,
    description: "file upload input",
  });

  await page.setInputFiles('input[type="file"]', ehpkPath);
  await waitForUploadCompletion(page, expectedVersion);
}

export async function waitForUploadCompletion(page, expectedVersion = APP_JSON.version) {
  if (expectedVersion) {
    try {
      await page.getByText(new RegExp(`\\bv?${escapeRegExp(expectedVersion)}\\b`, "i")).first().waitFor({
        state: "visible",
        timeout: 120_000,
      });
      await waitForLoadSettled(page);
      return;
    } catch {
      // Fall through to toast/status signals below.
    }
  }

  await page.getByText(/uploaded|upload complete|success|saved|new version/i).first().waitFor({
    state: "visible",
    timeout: 120_000,
  });
  await waitForLoadSettled(page);
}

async function selectBetaFromNativeSelect(page) {
  const selects = page.locator("select");
  const count = await selects.count();

  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    const betaOption = await select.evaluate((element) => {
      if (!(element instanceof HTMLSelectElement)) return null;
      const option = [...element.options].find((candidate) => /beta/i.test(candidate.textContent ?? ""));
      return option ? { value: option.value, label: option.textContent } : null;
    }).catch(() => null);

    if (!betaOption) continue;
    await select.selectOption(betaOption.value);
    return true;
  }

  return false;
}

async function confirmMaybe(page) {
  await maybeClickFirstVisible([
    page.getByRole("button", { name: /confirm/i }),
    page.getByRole("button", { name: /set to beta/i }),
    page.getByRole("button", { name: /publish/i }),
    page.getByRole("button", { name: /^ok$/i }),
    page.getByRole("button", { name: /^yes$/i }),
  ], {
    timeout: 3_000,
    description: "confirmation button",
  });
}

export async function setBetaStatus(page) {
  const details = await readBuildDetails(page);
  if (normalizeStatus(details.status) === "Beta") return;

  if (await selectBetaFromNativeSelect(page)) {
    await confirmMaybe(page);
    await waitForLoadSettled(page);
    return;
  }

  const clickedDirectBeta = await maybeClickFirstVisible([
    page.getByRole("button", { name: /^beta$/i }),
    page.getByRole("menuitem", { name: /^beta$/i }),
    page.getByRole("option", { name: /^beta$/i }),
  ], {
    timeout: 4_000,
    description: "Beta status option",
  });

  if (!clickedDirectBeta) {
    await clickFirstVisible([
      page.getByRole("button", { name: /private/i }),
      page.getByRole("button", { name: /status/i }),
      page.getByRole("button", { name: /visibility/i }),
      page.getByText(/\bPrivate\b/i),
    ], {
      timeout: 10_000,
      description: "status control",
    });

    await clickFirstVisible([
      page.getByRole("menuitem", { name: /^beta$/i }),
      page.getByRole("option", { name: /^beta$/i }),
      page.getByRole("button", { name: /^beta$/i }),
      page.getByText(/^Beta$/i),
    ], {
      timeout: 10_000,
      description: "Beta status option",
    });
  }

  await confirmMaybe(page);
  await page.getByText(/\bBeta\b/i).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await waitForLoadSettled(page);
}

export async function captureFailure(page, {
  screenshotPath = ERROR_SCREENSHOT_PATH,
  stderr = process.stderr,
} = {}) {
  if (!page) return;

  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  stderr.write(`Dev Portal automation failed at ${page.url()}\n`);
  stderr.write(`Screenshot: ${screenshotPath}\n`);
}

export async function login({
  baseUrl = BASE_URL,
  statePath = STATE_PATH,
  playwright,
  profileDir,
  stdout = process.stdout,
} = {}) {
  const pw = playwright ?? (await loadPlaywright());
  const userDataDir = profileDir ?? (await mkdtemp(path.join(os.tmpdir(), "pane-on-g2-dev-portal-")));
  const context = await pw.chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    stdout.write("Log in to Even Hub in the browser window. Waiting for dashboard...\n");
    await waitForLoginLanding(page);
    await context.storageState({ path: statePath });
    stdout.write(`Saved Dev Portal session to ${statePath}\n`);
  } finally {
    await context.close();
    if (!profileDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function publish({
  cwd = process.cwd(),
  baseUrl = BASE_URL,
  statePath = STATE_PATH,
  ehpkPath = EHPK_PATH,
  appJson = APP_JSON,
  packageId = PACKAGE_ID,
  playwright,
  existsSync = fs.existsSync,
  runBuild = buildEhpk,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let browser = null;
  let page = null;

  try {
    await ensureEhpk({ cwd, ehpkPath, existsSync, runBuild, stdout });
    const session = await openAuthenticatedContext({ baseUrl, statePath, existsSync, playwright });
    browser = session.browser;
    page = session.page;

    await openAppBuild(page, { baseUrl, packageId, appName: appJson.name });
    await uploadEhpk(page, { ehpkPath, expectedVersion: appJson.version });
    await setBetaStatus(page);

    const details = await readBuildDetails(page);
    const version = details.version ?? appJson.version;
    stdout.write(`Published ${formatVersion(version)} (Beta) at ${page.url()}\n`);
  } catch (error) {
    await captureFailure(page, { stderr });
    throw error;
  } finally {
    await browser?.close();
  }
}

export async function status({
  baseUrl = BASE_URL,
  statePath = STATE_PATH,
  appJson = APP_JSON,
  packageId = PACKAGE_ID,
  playwright,
  existsSync = fs.existsSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let browser = null;
  let page = null;

  try {
    const session = await openAuthenticatedContext({ baseUrl, statePath, existsSync, playwright });
    browser = session.browser;
    page = session.page;

    await openAppBuild(page, { baseUrl, packageId, appName: appJson.name });
    const details = await readBuildDetails(page);
    const version = formatVersion(details.version ?? appJson.version);
    const currentStatus = normalizeStatus(details.status) ?? "unknown";
    const testers = details.testerCount === null ? "unknown testers" : `${details.testerCount} testers`;

    stdout.write(`Current build: ${version} (${currentStatus}), ${testers} at ${page.url()}\n`);
  } catch (error) {
    await captureFailure(page, { stderr });
    throw error;
  } finally {
    await browser?.close();
  }
}

export async function main(argv = process.argv.slice(2), {
  commands = { login, publish, status },
  stderr = process.stderr,
} = {}) {
  const [command, ...rest] = argv;
  if (rest.length > 0 || !["login", "publish", "status"].includes(command)) {
    stderr.write(usage());
    return 64;
  }

  await commands[command]();
  return 0;
}

function isCliEntryPoint() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliEntryPoint()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
