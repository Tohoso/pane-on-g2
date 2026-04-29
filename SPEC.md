# pane-on-g2 SPEC

pane-on-g2 is a private WebView companion for Even Realities G2. It mirrors existing Claude Code tmux sessions and sends user input back to the selected pane.

## Goals

- Mirror assistant output from tmux/JSONL to G2 without depending on a hosted chatbot API.
- Let users switch between multiple local slots such as `cc`, `alpha`, `beta`, and `gamma`.
- Support text prompts, R1 ring quick replies, interrupts, and optional PCM audio transcription.
- Keep the G2 layout compact, predictable, and resilient to firmware text-window quirks.

## Non-Goals

- Running an agent runtime inside this app.
- Providing a public chatbot service.
- Managing Claude Code authentication.
- Renaming or owning the external provider adapter package.

## Components

```text
frontend/
  Vite WebView UI, G2 renderer, BLE recovery, audio lifecycle, SSE client

server/
  Node HTTP server, token auth, prompt/audio/interrupt routes, SSE broker, persistence

shared/
  Slot and PaneEvent protocol types

deploy/
  systemd-user unit, install/uninstall scripts, logrotate config
```

## Runtime Flow

1. WebView selects a slot.
2. Prompt/audio/interrupt requests go to the server with a bearer token.
3. The server forwards text or control signals to `tmux -L <slot>`.
4. The server tails Claude Code JSONL and polls pane snapshots.
5. Raw events are normalized into `PaneEvent` records.
6. SSE clients receive replay plus live events.
7. The frontend updates transcript state and G2 text containers.

## Config

`pane-on-g2.config.json`:

```json
{
  "label": "g2",
  "slots": ["cc", "alpha", "beta", "gamma"],
  "tmuxPrefix": "",
  "ringReplies": {
    "single_tap": { "text": "ack", "action": "prompt" },
    "double_tap": { "text": "progress?", "action": "prompt" },
    "long_press": { "text": "interrupt", "action": "interrupt" },
    "triple_tap": { "text": "be terse", "action": "prompt" }
  }
}
```

Important env vars:

- `PANE_ON_G2_TOKEN`
- `PANE_ON_G2_TOKEN_FILE`
- `PANE_ON_G2_BIND`
- `PANE_ON_G2_PORT`
- `PANE_ON_G2_LABEL`
- `PANE_ON_G2_SLOTS`
- `PANE_ON_G2_TMUX_PREFIX`
- `PANE_ON_G2_SESSION_CWD`
- `PANE_ON_G2_STT_PROVIDER`
- `PANE_ON_G2_TAP_DIR`
- `PANE_ON_G2_TAP_POLL_MS`
- `VITE_PANE_ON_G2_TOKEN`
- `VITE_PANE_ON_G2_API_BASE`
- `VITE_PANE_ON_G2_LABEL`

## Acceptance

- No user-specific branding in source code.
- Tests pass with `pnpm -r test`.
- Frontend builds with `pnpm --filter @pane-on-g2/frontend build`.
- The deploy unit is named `pane-on-g2.service`.
