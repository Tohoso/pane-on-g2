# @pane-on-g2/server

Node server for pane-on-g2. It provides token-authenticated prompt, audio, interrupt, health, slot status, and SSE endpoints for mirroring tmux-backed Claude Code sessions to Even Realities G2.

## Config

The server reads `pane-on-g2.config.json` from the project root at startup. Env vars override deployment fields:

- `PANE_ON_G2_TOKEN`
- `PANE_ON_G2_TOKEN_FILE`
- `PANE_ON_G2_BIND`
- `PANE_ON_G2_PORT`
- `PANE_ON_G2_LABEL`
- `PANE_ON_G2_SLOTS`
- `PANE_ON_G2_TMUX_PREFIX`
- `PANE_ON_G2_SESSION_CWD`
- `PANE_ON_G2_STT_PROVIDER`

Events persist to `~/.pane-on-g2/events.db` by default.

## Commands

```bash
corepack pnpm --filter @pane-on-g2/server test
corepack pnpm --filter @pane-on-g2/server dev
```
