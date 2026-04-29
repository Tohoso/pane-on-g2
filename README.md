# pane-on-g2

pane-on-g2 mirrors Claude Code sessions running in tmux to Even Realities G2 glasses. It gives the companion WebView a slot selector, text prompt form, ring quick replies, optional PCM audio upload for STT, and a compact G2 HUD fed by Server-Sent Events.

Default slots are `cc`, `alpha`, `beta`, and `gamma`, but they are configurable.

## Architecture

```text
Even iOS App WebView
  -> Vite frontend
  -> /api/prompt, /api/audio, /api/interrupt
  -> Node server
  -> provider adapter
  -> tmux -L <slot> send-keys / capture-pane
  -> Claude Code session JSONL tail
  -> normalized PaneEvent SSE
  -> WebView transcript + G2 text containers
```

The server does not run an agent. It forwards input to existing tmux sessions and translates their pane or JSONL output into a small display protocol.

## Requirements

- Node 22+ with Corepack and pnpm
- tmux
- Claude Code sessions running in tmux sockets, one socket per slot
- Even Realities G2 glasses paired through the iOS Even App
- Tailscale or another private network path to the server
- Optional local or cloud Whisper-compatible STT provider

## Quickstart

```bash
corepack enable
corepack pnpm install
cp .env.prod.example .env.prod
corepack pnpm test
corepack pnpm build
```

Edit `pane-on-g2.config.json`:

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

Generate a token and set it in `.env.prod`:

```bash
openssl rand -hex 32
PANE_ON_G2_TOKEN=replace-me
PANE_ON_G2_BIND=127.0.0.1
PANE_ON_G2_PORT=3457
```

Start tmux sessions with names matching each slot when `tmuxPrefix` is empty:

```bash
tmux -L cc new -s cc
tmux -L alpha new -s alpha
tmux -L beta new -s beta
tmux -L gamma new -s gamma
```

For production:

```bash
bash deploy/install.sh
```

Open the served WebView in the Even App flow, scan or enter the URL, and pair it with the G2 glasses.

## Configuration

`pane-on-g2.config.json` is optional. Defaults are baked in if the file is missing.

Config fields:

- `label`: G2 header prefix. Default `g2`.
- `slots`: tmux slot identifiers. Default `["cc", "alpha", "beta", "gamma"]`.
- `tmuxPrefix`: prefix for tmux session names. Default empty, so slot `alpha` targets session `alpha`.
- `ringReplies`: overrides for the four R1 gestures.

Environment variables override deployment knobs:

- `PANE_ON_G2_TOKEN`: bearer token for API requests.
- `PANE_ON_G2_TOKEN_FILE`: file containing the bearer token.
- `PANE_ON_G2_BIND`: server bind address.
- `PANE_ON_G2_PORT`: server port.
- `PANE_ON_G2_LABEL`: header prefix override.
- `PANE_ON_G2_SLOTS`: comma-separated slot override.
- `PANE_ON_G2_TMUX_PREFIX`: tmux session prefix.
- `PANE_ON_G2_SESSION_CWD`: cwd used to locate Claude Code JSONL session files.
- `PANE_ON_G2_STT_PROVIDER`: `groq`, `faster-whisper`, `whisper.cpp`, `openai-cloud`, `mock`, or `none`.
- `VITE_PANE_ON_G2_TOKEN`: frontend build-time token for static deployments.
- `VITE_PANE_ON_G2_API_BASE`: frontend API base URL.
- `VITE_PANE_ON_G2_LABEL`: frontend header label override.

Provider tap files still use `/tmp/even-tap/` by default. Override with `PANE_ON_G2_TAP_DIR` and `PANE_ON_G2_TAP_POLL_MS` when using tap-based streaming.

## Hardware Notes

Even G2 text containers are small and firmware scrolling can snap unexpectedly at boundaries. pane-on-g2 keeps a fixed header/body/footer layout, caps text by UTF-8 bytes, and uses explicit history windows so swipes remain predictable.

BLE pairing is owned by the Even App. If the WebView is alive but glasses stop updating, force-exit the app, reconnect the glasses in the Even App, then reopen the pane-on-g2 WebView.

## Development

```bash
corepack pnpm --filter @pane-on-g2/server dev
corepack pnpm --filter @pane-on-g2/frontend dev
corepack pnpm -r test
corepack pnpm --filter @pane-on-g2/frontend build
```

## Acknowledgements

Thanks to `wmoto-ai/cc-g2` and `Tohoso/tmux-on-g2` for prior art around Claude Code, tmux, and Even Realities G2 workflows.
