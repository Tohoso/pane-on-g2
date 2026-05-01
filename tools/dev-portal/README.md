# Even Hub Dev Portal Upload Automation

This folder contains the Playwright automation used by the root package scripts:

```bash
corepack pnpm run publish-login
corepack pnpm run publish-beta
corepack pnpm run publish-status
```

## One-time setup

Install dependencies and the Chromium browser binary once:

```bash
corepack pnpm install
corepack pnpm exec playwright install chromium
```

Then save a Dev Portal browser session on a machine with a display:

```bash
corepack pnpm run publish-login
```

The login command opens a headed Chromium window at `https://hub.evenrealities.com/login`.
Log in normally. When the browser reaches a non-login page, the script writes
`.dev-portal-state.json` at the repo root.

## Daily beta publish

After login state exists:

```bash
corepack pnpm run publish-beta
```

The command checks for `pane-on-g2.ehpk`; if it is missing or older than the app
manifest/frontend/shared inputs, it runs `bash scripts/ehpk.sh`. It then opens
the Dev Portal headlessly, finds the existing app whose `package_id` matches
`app.json`, uploads the package, switches the build from Private to Beta, and
prints the resulting build URL.

To inspect the current portal state without uploading:

```bash
corepack pnpm run publish-status
```

## Session file

`.dev-portal-state.json` contains login cookies and localStorage. It is
gitignored, but treat it like a credential: keep it offline, do not paste it into
issues or logs, and rotate it by deleting the file and re-running
`corepack pnpm run publish-login` if it is exposed.

## VPS and display-less machines

The `publish-beta` and `publish-status` flows are headless and can run on a VPS
after `.dev-portal-state.json` exists.

For the one-time `publish-login` step, either:

- use X11 forwarding, for example `ssh -X user@host`, then run
  `corepack pnpm run publish-login` on the VPS; or
- run `corepack pnpm run publish-login` locally on a desktop machine, then SCP
  `.dev-portal-state.json` to the repo root on the VPS.

## Failure recovery

The Dev Portal is a Nuxt 3 app and its markup may change. The script uses several
fallback selectors for app lookup, upload, and status controls. If a selector
fails, it writes `tools/dev-portal/last-error.png` and prints the URL it failed
on.

If automation cannot recover after re-running `publish-login`, use the manual
fallback:

1. Run `corepack pnpm run ehpk` if `pane-on-g2.ehpk` is missing.
2. Open `https://hub.evenrealities.com/dev`.
3. Open the `pane-on-g2` app.
4. Upload `pane-on-g2.ehpk`.
5. Set the build status from Private to Beta.

When this happens, update `tools/dev-portal/upload.mjs` with the new Dev Portal
selectors before relying on `publish-beta` again.
