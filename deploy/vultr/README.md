# Vultr deployment

This directory contains the long-running VPS setup for the Polymarket BTC
dual-track bot. The API server is the process that must stay alive on Vultr;
the Replit dashboard only reads its API and sends operator controls.

## Before installing

Do not enable live trading while an older bot may still have an active order or
position. Stop the old service first, then verify the Polymarket account has no
unresolved orders or inventory. The new process always starts `PAUSED` and
requires a deliberate ARM action after every restart.

The service is intentionally configured with `LIVE_TRADING_ENABLED=false`.
Change it to `true` only after credentials, proxy routing, market IDs, and the
account's current orders/positions have been verified.

## Initial setup

These commands assume Ubuntu/Debian and a deployment directory of
`/opt/polymarket-bot`.

```sh
sudo useradd --system --home /opt/polymarket-bot --shell /usr/sbin/nologin polymarket || true
sudo mkdir -p /opt/polymarket-bot /etc/polymarket-bot /var/lib/polymarket-bot
sudo chown -R polymarket:polymarket /opt/polymarket-bot /var/lib/polymarket-bot
```

Install Node.js 20+, pnpm, Python 3.11+, and the CLOB client used by
`artifacts/api-server/scripts/manage_clob_pair.py`. The same Python interpreter
must be used for both balance reads and order management:

```sh
cd /opt/polymarket-bot
corepack enable
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
# Install the exact py-clob-client-v2 package/version approved for this deployment.
python -m pip install py-clob-client-v2
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/api-server run build
```

Copy the environment template, fill it on the server, and protect it:

```sh
sudo cp deploy/vultr/polymarket-bot.env.example /etc/polymarket-bot/polymarket-bot.env
sudo chmod 600 /etc/polymarket-bot/polymarket-bot.env
sudo chown root:polymarket /etc/polymarket-bot/polymarket-bot.env
```

`RESIDENTIAL_PROXY_URL` must point to a proxy reachable from Vultr. Do not copy
the Replit value if it resolves to a Replit-local `127.0.0.1` sidecar; install
or configure the proxy on the VPS first.

Install and start the service:

```sh
sudo cp deploy/vultr/polymarket-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polymarket-bot
sudo systemctl status polymarket-bot
curl -fsS http://127.0.0.1:8080/api/healthz
```

## Updating from GitHub

Keep the old service paused and verify there are no unresolved orders before
pulling a new version. Then:

```sh
cd /opt/polymarket-bot
git fetch origin
git checkout main
git reset --hard origin/main
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/api-server run build
sudo systemctl restart polymarket-bot
sudo journalctl -u polymarket-bot -n 100 --no-pager
```

After every restart, verify the log contains `PAUSED` and manually reconcile the
account before enabling ARM. If the journal is missing, malformed, or an order
status is ambiguous, the supervisor stays fail-closed and must not be bypassed.

## Operational notes

- The bot is a persistent service, not a scheduled job or sleeping web process.
- Keep `/var/lib/polymarket-bot` persistent across updates; it contains the
  recoverable execution journal.
- Do not delete the journal while an order or position could exist.
- Run `pnpm --filter @workspace/api-server test` before each rollout.
- The dashboard should use the VPS API base URL; no signing keys belong in the
  browser.