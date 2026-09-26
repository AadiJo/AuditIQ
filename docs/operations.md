# Running AuditIQ

## Behind a reverse proxy

AuditIQ serves plain HTTP. Run it behind a proxy that terminates TLS, and set `BASE_URL` to the public address so sign-in cookies are marked secure and invite links point to the right place.

Caddy, with the server listening on its default `127.0.0.1:5180`:

```
auditiq.example.com {
  reverse_proxy 127.0.0.1:5180 {
    flush_interval -1
  }
}
```

`flush_interval -1` keeps run progress, which is sent as server-sent events, streaming instead of buffered.

## As a systemd service

```ini
# /etc/systemd/system/auditiq.service
[Unit]
Description=AuditIQ
After=network-online.target
Wants=network-online.target

[Service]
User=auditiq
WorkingDirectory=/opt/auditiq
Environment=NODE_ENV=production
Environment=BASE_URL=https://auditiq.example.com
Environment=DATA_DIR=/var/lib/auditiq
ExecStart=/usr/bin/node apps/server/src/index.ts
Restart=on-failure
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Build the web app once with `pnpm install && pnpm build` in `/opt/auditiq` before starting. To use CLI logins, sign in as the service user: `sudo -u auditiq -H pnpm cli-login claude`.

## Backups

```bash
pnpm backup
```

This writes a consistent copy of the database and every uploaded contract to `DATA_DIR/backups/<timestamp>`. It's safe while the server runs. Copy that folder off the machine. `AUDITIQ_SECRET`, or the generated `DATA_DIR/secret`, is needed to read the stored Jira token and API keys after a restore. Without it, re-enter them in Settings.

In Docker, back up the `auditiq-data` volume, or run `docker compose exec auditiq node apps/server/scripts/backup.ts`.

## Upgrading

Pull the new version, run `pnpm install && pnpm build` (or rebuild the image), and restart. Migrations run at boot. Runs that were in progress when the server stopped are marked failed and can be run again.

## Troubleshooting

**Claude or Codex shows "not ready" in Settings.** The message says which credential is missing. Sign the CLI in as the user AuditIQ runs as (`pnpm cli-login claude` or `pnpm cli-login codex`), or add an API key. If the host's Codex uses a custom model provider, the provider's key variable must be set in AuditIQ's environment too. The message names the variable.

**Publishing fails with a Jira error.** The error text comes from Jira. Common causes: the issue type needs a required field AuditIQ doesn't fill, or the account can't create issues in the project. Failed publishes retry automatically and are listed on the Jira activity page.

**Findings are held back.** Open the finding to see why. Usually a quote doesn't match the clause it cites. A scanned PDF with no text layer has no clauses to check against, so every finding stays local. Run it through OCR first.

**The end-to-end tests stall for minutes at startup.** Playwright checks that the test ports are free before starting servers. On some machines, WSL with Tailscale for example, connecting to a closed port on `127.0.0.1` hangs instead of failing. The suite listens on `::1` by default to avoid this. Set `E2E_HOST` to use another address.
