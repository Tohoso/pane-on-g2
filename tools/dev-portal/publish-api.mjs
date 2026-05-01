// publish-api.mjs — Headless, no Playwright, no SPA hydration.
//
// Reads the JWT from .dev-portal-state.json (saved by `pnpm run publish-login`)
// and replays the two-step Even Hub upload flow:
//   POST /api/v1/versions/draft?package_id=...  (multipart, ehpk)
//   POST /api/v1/versions/create?package_id=... (multipart, draft_id)
//
// Falls back to /api/v1/auth/refresh if the access token has expired.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const STATE_PATH = path.join(ROOT, ".dev-portal-state.json");
const APP_JSON = path.join(ROOT, "app.json");
const EHPK = path.join(ROOT, "pane-on-g2.ehpk");
const BASE = "https://hub.evenrealities.com";

function die(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function loadAuthState() {
  if (!fs.existsSync(STATE_PATH)) {
    die(`${STATE_PATH} not found. Run: corepack pnpm run publish-login`);
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const origin = state.origins?.find((o) => o.origin === "https://hub.evenrealities.com");
  if (!origin) die("Dev Portal origin missing from state file. Re-run publish-login.");
  const authEntry = origin.localStorage?.find((kv) => kv.name === "er_auth_state_store");
  if (!authEntry) die("Auth entry missing from state file. Re-run publish-login.");
  const auth = JSON.parse(authEntry.value);
  if (!auth.accessToken) die("accessToken missing from auth state. Re-run publish-login.");
  return auth;
}

function saveAuthState(auth) {
  if (!fs.existsSync(STATE_PATH)) return;
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const origin = state.origins?.find((o) => o.origin === "https://hub.evenrealities.com");
  if (!origin) return;
  const entry = origin.localStorage?.find((kv) => kv.name === "er_auth_state_store");
  if (!entry) return;
  entry.value = JSON.stringify(auth);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function authHeaders(token) {
  return {
    "x-even-authorization": token,
    "user-agent": "pane-on-g2-publisher/0.1",
  };
}

async function tryRefresh(auth) {
  if (!auth.refreshToken) return null;
  const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { ...authHeaders(auth.accessToken), "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: auth.refreshToken }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== 0 || !json.data) return null;
  const refreshed = { ...auth, ...json.data };
  saveAuthState(refreshed);
  return refreshed;
}

async function selfCheck(auth) {
  const res = await fetch(`${BASE}/api/v1/auth/self_check`, {
    method: "GET",
    headers: authHeaders(auth.accessToken),
  });
  if (!res.ok) return false;
  const json = await res.json().catch(() => ({}));
  return json.code === 0;
}

async function ensureAuth() {
  let auth = loadAuthState();
  if (await selfCheck(auth)) return auth;
  console.log("Access token expired; trying refresh...");
  const refreshed = await tryRefresh(auth);
  if (refreshed && (await selfCheck(refreshed))) {
    console.log("Refresh ok.");
    return refreshed;
  }
  die("Both access and refresh tokens expired. Re-run: corepack pnpm run publish-login");
}

async function uploadDraft(auth, packageId) {
  if (!fs.existsSync(EHPK)) {
    console.log("ehpk missing; building...");
    execSync("bash scripts/ehpk.sh", { cwd: ROOT, stdio: "inherit" });
  }
  const ehpkBytes = fs.readFileSync(EHPK);
  const candidateFields = ["package", "file", "ehpk", "upload"];
  let lastError = "";
  for (const fieldName of candidateFields) {
    const form = new FormData();
    form.set(fieldName, new Blob([ehpkBytes], { type: "application/octet-stream" }), "pane-on-g2.ehpk");
    const res = await fetch(`${BASE}/api/v1/versions/draft?package_id=${encodeURIComponent(packageId)}`, {
      method: "POST",
      headers: authHeaders(auth.accessToken),
      body: form,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { lastError = `non-JSON: ${text.slice(0, 200)}`; continue; }
    if (res.ok && json.code === 0) {
      console.log(`(draft uploaded with field "${fieldName}")`);
      return json.data;
    }
    lastError = `code=${json.code} message=${json.message || ""}  field="${fieldName}"`;
  }
  die(`draft upload failed: ${lastError}`);
}

async function setBranchVersion(auth, packageId, versionName, branchName = "beta") {
  const res = await fetch(`${BASE}/api/v1/apps/branch-version?package_id=${encodeURIComponent(packageId)}`, {
    method: "POST",
    headers: { ...authHeaders(auth.accessToken), "content-type": "application/json" },
    body: JSON.stringify({ branch_name: branchName, version_name: versionName }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { die(`branch flip non-JSON response: ${text.slice(0, 200)}`); }
  if (!res.ok || json.code !== 0) die(`branch flip failed: code=${json.code} message=${json.message || ""}`);
}

async function finalizeVersion(auth, packageId, draftId) {
  const form = new FormData();
  form.set("draft_id", draftId);
  const res = await fetch(`${BASE}/api/v1/versions/create?package_id=${encodeURIComponent(packageId)}`, {
    method: "POST",
    headers: authHeaders(auth.accessToken),
    body: form,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { die(`create response not JSON: ${text.slice(0, 200)}`); }
  if (!res.ok || json.code !== 0) die(`version create failed (${res.status}): ${json.message || text.slice(0, 200)}`);
  return json.data;
}

async function main() {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, "utf8"));
  const packageId = appJson.package_id;
  if (!packageId) die("app.json missing package_id");

  console.log(`Publishing ${appJson.name} v${appJson.version} (package_id: ${packageId})`);

  const auth = await ensureAuth();
  console.log("Auth ok.");

  const draft = await uploadDraft(auth, packageId);
  console.log(`Draft uploaded: ${draft.draft_id} (manifest version ${draft.manifest?.version})`);

  const version = await finalizeVersion(auth, packageId, draft.draft_id);
  console.log(`Version finalized: ${version.version} (id ${version.id})`);

  const branch = process.env.PANE_ON_G2_PUBLISH_BRANCH || "beta";
  if (branch !== "none") {
    await setBranchVersion(auth, packageId, version.version, branch);
    console.log(`Branch "${branch}" → ${version.version}`);
  }

  console.log(`\n✅ Published version ${version.version} on branch ${branch}`);
  console.log(`   File: ${version.file_size} bytes at ${version.package_path}`);
  console.log(`   Build URL: ${BASE}/hub/${packageId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
