# Deploying on the Pi

The app binds `127.0.0.1` and expects TLS to be terminated in front of it by a
Cloudflare Tunnel, exactly like the troop's other tools. It is a Node 20+
service with one SQLite file; nothing else is needed on the box.

## First install

```bash
cd /home/pi
git clone https://github.com/<owner>/tl-service-stars.git
cd tl-service-stars
cp .env.example .env
chmod 600 .env
$EDITOR .env          # ADMIN_EMAILS, TROOP_ID, TROOP_NAME, TZ, PUBLIC_URL, PORT
bash deploy/install-pi.sh
```

`install-pi.sh` installs dependencies, backs up any existing database, runs
migrations, installs and starts the systemd unit, and checks `/health`. It
refuses to run without a `.env`, and never writes one.

Then read the one-time password out of the log and sign in:

```bash
journalctl -u tl-service-stars --since "5 min ago" | grep -A2 "First-run account"
```

## Choosing a port

The troop already runs the check-in app on 3000 and its AHG sibling on 3001,
and the badge tracker on 3100. This app defaults to **3200**. Check before you
commit to it:

```bash
ss -ltnp | grep -E ':(3000|3001|3100|3200)'
```

## The tunnel

Add an ingress rule for the hostname alongside the existing ones, then
restart cloudflared:

```yaml
  - hostname: stars.example.org
    service: http://127.0.0.1:3200
```

Two things this box has already taught us the hard way:

- **Force HTTP/2.** QUIC is unreliable over the Pi's Wi-Fi; the tunnel config
  should carry `protocol: http2`.
- **`TimeoutStartSec=90`** on the cloudflared unit, or it crash-loops on a
  slow start.

Both are already set for the other hostnames on this box — you are adding an
ingress rule, not a new tunnel.

## Updating

```bash
cd /home/pi/tl-service-stars
git fetch origin
git merge --ff-only origin/main
bash deploy/install-pi.sh
```

Run each step as its own command over `ssh pi` rather than chaining them.

## Backups

`install-pi.sh` takes a `data/pre-deploy-<timestamp>.db` before every
migration. For a backup by hand (there is no `sqlite3` CLI on this Pi, so use
the app's own driver):

```bash
cd /home/pi/tl-service-stars
node -e "require('better-sqlite3')('data/stars.db').exec(\"VACUUM INTO 'data/backup-$(date +%F).db'\")"
```

Everything under `data/` is trailman data: keep it off shared storage and out
of git (the `.gitignore` already fences it).

## Health and logs

```bash
curl -s http://127.0.0.1:3200/health | jq
journalctl -u tl-service-stars -f
```

`/health` is unauthenticated on purpose (it is behind the tunnel) and reports
only whether the portal session is connected and when the last sync ran — no
names, no counts.

## If the portal session drops

Trail Life Connect expires sessions on its own schedule, and a password
sign-in always demands a texted code. When that happens the nightly sync
records a failed run and parks a challenge; an admin opens
**Settings → Trail Life Connect**, presses **Connect**, and types the code.
That is the only routine manual step, and it is deliberate — see the comment
at the top of `server/lib/portalsession.js` for why the code is never
retrieved automatically.
