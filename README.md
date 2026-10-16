# Sayl

**Sayl** (Arabic سيل, "torrent" or "flash flood") downloads torrents right in your browser. Paste a magnet link or drop a `.torrent`, pick files, save them. You can also share: seed what you downloaded, or turn your own files into a torrent and seed them from the tab. Nothing to install, no server holding anyone's files, and free for everyone.

There are two ways to run it:

- **In the browser** (the default). The BitTorrent client runs in the page, and each person's own free Cloudflare Worker, the **relay**, connects it to peers. The website runs on Cloudflare Workers: the built site as static files, plus a small Worker for relay setup and TURN logins.
- **On a server** (self-hosted). The original version: qBittorrent on a VPS downloads for everyone and hands out the files over HTTPS. See *The server version* below.

## How it fits together

```
sayl.kitaaura.com          Cloudflare Workers: the website (static files) and its Worker (relay setup, TURN logins)
  └─ in each visitor's browser:
       BitTorrent client (client/)  ── WSS ──>  their relay (relay/), a Worker on their own Cloudflare account
       files in the browser's private storage (OPFS), saved to disk when they choose
                                                   └─ TCP ──> peers and trackers
                                                   └─ TURN ──> the DHT, only as a last resort
```

Finding peers, in order: the torrent's own trackers and about 25 public HTTP trackers, then PEX, and only when that finds no one, the DHT through a TURN server. See [relay/README.md](relay/README.md) for the relay, the DHT setup, what the relay agrees to carry, and measured speeds (17–20 MB/s on a home connection).

**Sharing** is opt-in, per torrent: the "seed after" chip, the seed button on a finished torrent, or *share your files* (pick files or a folder, or drop them on the page). A torrent being shared uploads while it runs and keeps seeding once complete, until it has uploaded the ratio limit (settings: 0.5, 1 or 2 times its size; 1 by default) or the tab closes. Relays can't accept incoming connections, so a seeder connects out to the peers the trackers name (asking the magnet's 10 trackers every 5 minutes) and reconnects to peers that drop it. A torrent made in Sayl lists the public HTTP trackers, and its files are copied into the browser's storage, so seeding survives a reload. Seeders never use the DHT, to spare the TURN quota.

**Direct connections (WebRTC)** are off by default and turned on in settings. With them on, Sayl also trades pieces straight with other browsers, the way WebTorrent does: other Sayl tabs and WebTorrent apps, found through public WebTorrent trackers (`wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev`, `wss://tracker.files.fm:7073`), with Google's and Twilio's free STUN servers. This doesn't go through the relay, so it's faster and lets other browsers reach a seeder within seconds; the cost is that those browsers and trackers see the person's IP address. Torrents made with it on also list the WebTorrent trackers in their magnet. Seeding rules are the same either way.

## Put it online

1. **The website**, on Cloudflare Workers. *Workers & Pages → Create → Import a repository* → this repo, with:

   | Setting | Value |
   |---|---|
   | Root directory | `frontend` |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |

   The Worker is named in `frontend/wrangler.jsonc` (`sayl`); the project's name must match it. Then add a custom domain under the Worker's *Settings → Domains & Routes*. Cloudflare Pages works too: root directory `frontend`, build command `npm run build`, output directory `build`.

   Build variables:

   | Variable | Example | Default |
   |---|---|---|
   | `ENGINE` | `browser` | `browser` when `API_URL` is not set |
   | `SITE_URL` | `https://sayl.kitaaura.com` | `https://sayl.kitaaura.com` |
   | `APP_NAME` | `Sayl` | `name` in `brand.json` |
   | `ABUSE_EMAIL` | `abuse@kitaaura.com` | `abuseEmail` in `brand.json` |

   A site built with `API_URL` set uses the server version unless `ENGINE=browser`.

2. **"Set up with cloudflare"** (optional, but it's how most people will get a relay). The website's Worker can install a relay into each visitor's own Cloudflare account after they approve it. That needs a Cloudflare OAuth client for Sayl:

   1. In the Cloudflare dashboard: **Manage Account → OAuth clients → Create client**.
      - Name `Sayl`; response type `code`; grant type `authorization_code`; token authentication method `client_secret_basic`.
      - Redirect URL: `https://sayl.kitaaura.com/api/relay/callback`.
      - Client URL: `https://sayl.kitaaura.com`. Add a logo.
      - Scopes, all required: **Account Settings → Read** and **Workers → Admin** and **Edit** (`account-settings.read`, `workers-scripts.admin`, `workers-scripts.edit`). Creating a Worker needs Admin.
   2. Copy the **client ID** and **client secret** (the secret is shown once).
   3. Give them to the website's Worker as secrets, in `frontend/` (or in the dashboard under the Worker's *Settings → Variables and Secrets*, type *Secret*):

      ```sh
      npx wrangler secret put OAUTH_CLIENT_ID
      npx wrangler secret put OAUTH_CLIENT_SECRET
      npx wrangler secret put SESSION_SECRET      # any long random string: openssl rand -hex 32
      ```

   4. A new client is **private**: only members of your Cloudflare account can use it, which is right for testing. To open it to everyone, verify the client URL's domain (Cloudflare gives you a `TXT` record to add to `kitaaura.com`), then **Change Visibility → public**. That can't be undone.

   Without these secrets the site still works; it just asks people to paste a relay they set up themselves ([relay/README.md](relay/README.md)).

   If Cloudflare rejects the scope names, set `OAUTH_SCOPES` (a plain variable, space-separated) to the IDs your client shows.

3. **The DHT for everyone** (optional). Relays made by "set up with cloudflare" have no TURN login of their own, so the website's Worker can hand out one from your [Metered](https://www.metered.ca) account (free plan: 20 GB a month, no card). A page asks its own relay first, and the website only when the relay has none. In `frontend/` (or in the dashboard as secrets), either:

   - **logins made on demand** (recommended: each one expires after 2 hours, so a copied login stops working). The app name is the part before `.metered.live` in your Metered app's address; the secret key is in the Metered dashboard:

     ```sh
     npx wrangler secret put METERED_APP
     npx wrangler secret put METERED_SECRET_KEY
     ```

   - **or a fixed login**, from *TURN Server → Credentials → Add Credential*:

     ```sh
     npx wrangler secret put TURN_URLS          # turns:standard.relay.metered.ca:443?transport=tcp,turn:standard.relay.metered.ca:80?transport=tcp
     npx wrangler secret put TURN_USERNAME
     npx wrangler secret put TURN_CREDENTIAL
     ```

   The TURN server must be one relays may reach (`TURN_HOSTS` in `relay/wrangler.toml`: Metered and Xirsys). Anyone using the site can use these logins, so the 20 GB is shared by all of them. DHT lookups are small (about 20 KB each), but if the month's quota runs out, the DHT stops until it resets; downloads carry on through trackers and PEX, and nothing is charged.

How "set up with cloudflare" works: the visitor approves Sayl on Cloudflare's own page; the website's Worker (`frontend/worker/index.js`) uploads `sayl-relay` to their account with a new random token, turns on its `workers.dev` address (registering one for the account if it has none), revokes the sign-in, and sends the browser home with the relay's address and token. Nothing is stored on Sayl's side. Setting up again from another device reuses the same relay and token.

Downloads stay in the visitor's browser storage until they remove them. Chrome and Edge give a site up to about 60% of the free disk; Firefox and Safari give less.

## Run it locally

```sh
cd relay && npm install && npx wrangler dev        # the relay on http://localhost:8787
cd frontend && npm install && npm run dev          # the site on http://localhost:5173
```

Open the site and enter `http://localhost:8787` as the relay.

## Repo layout

| Path | What it is |
|---|---|
| `frontend/` | The SvelteKit website. `src/lib/browser/` is the browser engine; `worker/` is the website's Worker, which installs relays. |
| `client/` | The BitTorrent client the website runs: peer protocol, metadata from magnets, PEX, HTTP trackers, the DHT over TURN, piece picking and checks, seeding, and making torrents. Plain JS, also runs in Node. |
| `relay/` | The relay Worker, its command-line tools, and the end-to-end tests. |
| `brand.json` | The product name. Change it here (or set `APP_NAME`) to rename everything. |
| `backend/`, `deploy/`, `docker-compose.yml`, `.env.example` | The server version. |

## The server version

Self-hosted on a VPS: qBittorrent downloads for everyone, and the site hands out the files over HTTPS. Build the website with `API_URL` set (or `ENGINE=server`). [docs/DEPLOY.md](docs/DEPLOY.md) is the full guide.

```
browser ──> sayl.kitaaura.com      Cloudflare Pages (static SvelteKit site)
        ──> sayl-api.kitaaura.com  Cloudflare Tunnel ──> backend:8080 (API)
        ──> sayl-dl.kitaaura.com   DNS only ──> Caddy :443 ──> backend:8081 (file downloads)

VPS (Oracle Cloud Always Free, Docker):
  qbittorrent  torrent engine, web UI never exposed; only the peer port is open
  backend      Node.js + Fastify, the only thing that talks to qBittorrent
  cloudflared  outbound tunnel for the API, no inbound web ports needed
  caddy        HTTPS for downloads with a free Let's Encrypt certificate
```

Downloads skip Cloudflare's proxy on purpose: serving large files through the free CDN goes against Cloudflare's terms.

### Run it locally

Needs Docker and Node.js 22.

```sh
cp .env.example .env
# fill in QBIT_PASSWORD, SESSION_SECRET, DOWNLOAD_URL_SECRET (openssl rand -hex 32)
# and set COMPOSE_PROFILES= (empty) so cloudflared and caddy stay off
docker compose up -d --build --wait     # --wait returns once the backend has set up qBittorrent
curl localhost:8080/api/health          # {"app":"Sayl","status":"ok"}
docker compose exec backend sayl-admin status
```

For downloads to work locally, also set `DL_PUBLIC_URL=http://localhost:8081` and `FRONTEND_ORIGIN=http://localhost:5173`.

`sayl-admin status` prints the qBittorrent version and the protocol settings it's actually running with (DHT, PEX, LSD, TCP + uTP, encryption, port, IPv4 + IPv6, caps), and says whether they match `.env`.

Frontend (talks to the API on `localhost:8080`):

```sh
cd frontend && npm install && ENGINE=server npm run dev    # http://localhost:5173
```

The site is plain static files (SvelteKit, every page prerendered). For the server version, set these in Cloudflare Pages under *Settings → Variables*:

| Variable | Example | Default |
|---|---|---|
| `ENGINE` | `server` | `server` when `API_URL` is set |
| `API_URL` | `https://sayl-api.kitaaura.com` | `http://localhost:8080` |
| `SITE_URL` | `https://sayl.kitaaura.com` | `https://sayl.kitaaura.com` |
| `APP_NAME` | `Sayl` | `name` in `brand.json` |
| `ABUSE_EMAIL` | `abuse@kitaaura.com` | `abuseEmail` in `brand.json` |
| `TURNSTILE_SITE_KEY` | from Cloudflare Turnstile | empty (captcha off) |

Fonts (IBM Plex Mono, Inter) are bundled from `@fontsource`, icons are [Lucide](https://lucide.dev). Theme, motion and download preferences stay in the browser's localStorage.

### Deploying

[docs/DEPLOY.md](docs/DEPLOY.md) walks through everything: the Oracle VM, its two firewalls, Docker, the Cloudflare tunnel, DNS, Turnstile, Pages, testing and day-to-day running.

To check a live deployment end to end from any computer with Node.js 22:

```sh
node scripts/smoke.mjs https://sayl-api.kitaaura.com [--code <access code>] [--full]
```

It adds the current Debian netinst ISO, waits for the server to download it from real peers, checks the download link (and with `--full`, the whole file against Debian's SHA-256), then removes it.

#### qBittorrent settings

The backend applies these on every start and reads them back; `sayl-admin status` shows any difference.

| Setting | Value |
|---|---|
| DHT, PEX, local peer discovery | on |
| Transport | TCP and uTP |
| Encryption | `ENCRYPTION_MODE` (default: prefer encrypted) |
| Listen port | `TORRENT_PORT`, fixed, UPnP off |
| Addresses | all IPv4 and IPv6 (set `ENABLE_IPV6=false` only if the VPS kernel has IPv6 off) |
| Upload / download caps | `UPLOAD_LIMIT_KIBPS` (default 5120 KiB/s) / `DOWNLOAD_LIMIT_KIBPS` (default unlimited) |
| Active torrents | `GLOBAL_MAX_ACTIVE_TORRENTS` (default 20) |
| Web UI | port 8080 on the internal Docker network only, PBKDF2 password from `.env` |
| SSRF mitigation, block peers on ports below 1024 | on |

### API

All routes are under `https://sayl-api.kitaaura.com`. The browser sends the session cookie (`credentials: 'include'`); requests that change something must come from `FRONTEND_ORIGIN`. Errors look like `{"error": "not_found", "message": "that torrent isn't in your list"}`.

| Method and path | What it does |
|---|---|
| `GET /api/session` | Whether a session exists, plus the limits to show in the UI. |
| `POST /api/session` | Starts an anonymous session (signed, httpOnly cookie). |
| `DELETE /api/session` | Ends it. |
| `GET /api/torrents` | Your torrents. |
| `POST /api/torrents` | Add one: JSON `{"source": "magnet:…"}` or `{"source": "https://…/x.torrent"}`, or a multipart upload with a `torrent` file field. |
| `GET /api/torrents/:hash/files` | The file list, once metadata has arrived. |
| `POST /api/torrents/:hash/select` | Pick files and start: `{"files": [0, 2], "seed": false, "sequential": false, "ratioLimit": 1}`. |
| `POST /api/torrents/:hash/pause` · `resume` · `recheck` · `stop-seeding` | Controls. |
| `DELETE /api/torrents/:hash` | Remove it. |
| `DELETE /api/torrents` | Remove all of yours. |
| `GET /api/torrents/:hash/links` | Signed download links (valid 6 hours) for finished files, plus a zip link when there's more than one. |
| `GET /api/events` | Server-sent events: a `torrents` event with your full list whenever it changes. |

**How a torrent moves:** `metadata` (magnet looking for its file list) → `selecting` (waiting for you to pick files) → `queued` / `downloading` / `stalled` / `checking` → `seeding` (if you asked, up to `SEED_MAX_MINUTES` or your ratio limit) → `done`. You can also be `paused`, or see `error`.

**Isolation:** every torrent carries an `owner-…` tag in qBittorrent and a row in the database, and both must match before anything is shown or changed. Someone else's torrent answers exactly like one that doesn't exist (404). If two people add the same torrent, qBittorrent keeps one copy: each person has their own file choice, pause state and seeding settings, and the data is deleted when the last owner removes it.

**Downloads** come from `https://sayl-dl.kitaaura.com/dl/<token>/<name>`. Links check ownership again on every request, support byte ranges (resumable downloads), and the zip streams with a known size, so browsers show progress.

### Limits and cleanup

All of these are in `.env`.

| What | Default |
|---|---|
| Unfinished torrents | 3 per session, 3 per IP |
| Stored data | 20 GB per session, 20 GB per IP |
| One torrent's picked files | 20 GB |
| Whole server | 120 GB reserved, and `DISK_RESERVE_GB` (2 GB) always left free on disk |
| Finished files kept | 24 h up to 3 GB, 12 h up to 5 GB, 6 h up to 10 GB, 3 h up to 20 GB |
| Seeding | stops after 60 minutes or at the ratio limit |
| No progress | unfinished torrents with no progress for 6 h are deleted (paused, stuck on metadata, or files never picked) |
| Requests | 120 per minute per IP; 30 adds per hour per session and per IP; 10 new sessions per hour per IP; 4 open tabs per session |

Space is counted when files are picked, not as they download, so many half-finished torrents can't overfill the disk. A torrent shared by several people is stored once and counted against each of them. Anything in qBittorrent that Sayl has no record of (and the reverse) is cleaned up after 10 minutes.

**Access:** set `ACCESS_CODE` to require a code before anyone gets a session (the beta), and `TURNSTILE_SECRET_KEY` plus the Pages variable `TURNSTILE_SITE_KEY` for the Cloudflare Turnstile captcha. Leave either empty to turn it off. Both are checked once, when a session starts.

### Admin

There is no admin website or endpoint. On the VPS:

```sh
docker compose exec backend sayl-admin status                      # engine version and protocol settings
docker compose exec backend sayl-admin list --ips                  # every torrent, its owners and their IPs
docker compose exec backend sayl-admin block <hash|magnet> [reason] # delete for everyone, refuse it from now on
docker compose exec backend sayl-admin unblock <hash|magnet>
docker compose exec backend sayl-admin ban-ip <ip> [reason] [--purge]   # --purge also deletes its torrents
docker compose exec backend sayl-admin unban-ip <ip>
docker compose exec backend sayl-admin blocklist
```

For a takedown notice: find the torrent (`list`), then `block` it. For repeat abuse from one address, `ban-ip --purge`.

## Tests

```sh
cd client && npm test                      # bencode, magnets, trackers, piece-to-file mapping, TURN logins, making torrents
cd relay && npm test                       # what the relay agrees to carry
cd relay && node test/local.mjs            # relay + client against a real qBittorrent (Docker)
cd relay && node test/website.mjs          # the website in browser mode, clicked through in Chromium
cd relay && node test/setup.mjs            # "set up with cloudflare", against a stand-in for Cloudflare's sign-in and API
cd relay && node test/webrtc.mjs           # direct connections: Sayl tab to Sayl tab, and Sayl with the WebTorrent client, both ways
cd backend && npm install && npm test      # the server version
```

The server version's tests run against an in-memory stand-in for qBittorrent's API. They cover sessions, cross-site protection, isolation between users (every route, shared torrents, tag mismatches), file selection, seeding limits, `.torrent` validation, private-address blocking for pasted URLs, signed links, byte ranges, zips, path traversal, quotas (per session, per IP, server-wide, disk), retention and stall cleanup, orphans, the blocklist, IP bans, the access code, the captcha and rate limits.

## License

MIT. See [LICENSE](LICENSE).
