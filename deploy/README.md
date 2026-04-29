# pane-on-g2 production deploy

Target: a user-level systemd service running the pane-on-g2 server. The current Linode target is `127.0.0.1:3457`.

## Setup

1. Create `.env.prod` in the project root:

   ```bash
   cp .env.prod.example .env.prod
   chmod 600 .env.prod
   ```

2. Set at least:

   ```bash
   PANE_ON_G2_TOKEN=replace-me
   PANE_ON_G2_BIND=127.0.0.1
   PANE_ON_G2_PORT=3457
   ```

3. Build the frontend:

   ```bash
   pnpm build
   ```

4. Install and start the user service:

   ```bash
   bash deploy/install.sh
   ```

5. Check health:

   ```bash
   curl http://127.0.0.1:3457/health
   ```

## Migration

Rename production env keys before enabling `pane-on-g2.service`:

```text
AYU_EVEN_APP_TOKEN -> PANE_ON_G2_TOKEN
AYU_EVEN_BIND -> PANE_ON_G2_BIND
AYU_EVEN_PORT -> PANE_ON_G2_PORT
AYU_EVEN_STT_PROVIDER -> PANE_ON_G2_STT_PROVIDER
AYU_EVEN_TOKEN_FILE -> PANE_ON_G2_TOKEN_FILE
VITE_AYU_EVEN_APP_TOKEN -> VITE_PANE_ON_G2_TOKEN
VITE_AYU_EVEN_API_BASE -> VITE_PANE_ON_G2_API_BASE
```

The old event database directory was `~/.ayu-even-app/`; the new one is `~/.pane-on-g2/`.

## Logs

Runtime logs go to `~/.pane-on-g2/server.log`.

To install log rotation, copy or symlink `deploy/pane-on-g2.logrotate` into the system logrotate config path used on the VPS.

## Uninstall

```bash
bash deploy/uninstall.sh
```
