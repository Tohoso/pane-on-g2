# @pane-on-g2/frontend

Vite WebView client for pane-on-g2. It renders the companion UI, manages slot selection, streams `PaneEvent` SSE updates, captures optional Even SDK audio PCM, and updates the Even Realities G2 text containers.

## Env

- `VITE_PANE_ON_G2_TOKEN`: bearer token used by the WebView.
- `VITE_PANE_ON_G2_API_BASE`: API base URL. Empty means same origin.
- `VITE_PANE_ON_G2_LABEL`: label shown before the active slot. Defaults to `g2`; Vite also reads `pane-on-g2.config.json`.

## Commands

```bash
corepack pnpm --filter @pane-on-g2/frontend test
corepack pnpm --filter @pane-on-g2/frontend build
corepack pnpm --filter @pane-on-g2/frontend dev
```
