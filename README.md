# Sayl

**Sayl** (Arabic سيل, "torrent" or "flash flood") downloads torrents on a server and hands you the files over HTTPS. Paste a magnet link or drop a `.torrent`, pick files, download them in the browser.

> Status: **stage 1 of 5** (scaffold and Docker stack). The API, UI, quotas and full docs land in later stages.

## How it fits together

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

## Repo layout

| Path | What it is |
|---|---|
| `brand.json` | The product name. Change it here (or set `APP_NAME`) to rename everything. |
| `docker-compose.yml` | The whole VPS stack. |
| `.env.example` | Every setting and secret, with comments. |
| `backend/` | Fastify API (TypeScript). |
| `frontend/` | SvelteKit site for Cloudflare Pages. |
| `deploy/qbit-init/` | Writes qBittorrent's login and port before it starts. |
| `deploy/caddy/` | Caddy config for the download domain. |

## Run it locally

Needs Docker and Node.js 22.

```sh
cp .env.example .env
# fill in QBIT_PASSWORD, SESSION_SECRET, DOWNLOAD_URL_SECRET (openssl rand -hex 32)
# and set COMPOSE_PROFILES= (empty) so cloudflared and caddy stay off
docker compose up -d --build
curl localhost:8080/api/health          # {"app":"Sayl","status":"ok"}
docker compose exec backend sayl-admin status
```

`sayl-admin status` prints the qBittorrent version and the protocol settings it's actually running with (DHT, PEX, LSD, TCP + uTP, encryption, port, IPv4 + IPv6, caps), and says whether they match `.env`.

Frontend:

```sh
cd frontend && npm install && npm run dev
```

## Deploying (outline)

A step-by-step guide comes in stage 5. The shape of it:

1. **Oracle Cloud:** create an Always Free Ampere (ARM) VM with Ubuntu. Open TCP 80, TCP + UDP 443 and TCP + UDP `TORRENT_PORT` (default 6881) in the VCN security list *and* in the VM's own firewall (Oracle's Ubuntu images block ports with iptables by default). Install Docker.
2. **Cloudflare Tunnel:** in Zero Trust, create a tunnel, copy its token into `TUNNEL_TOKEN`, and add the public hostname `sayl-api.kitaaura.com` → `http://backend:8080`.
3. **DNS:** add an `A` (and `AAAA` if the VM has IPv6) record for `sayl-dl` pointing at the VM, with the proxy **off** (grey cloud).
4. **VPS:** clone this repo, `cp .env.example .env`, fill it in, `docker compose up -d --build`.
5. **Cloudflare Pages:** connect the repo, root directory `frontend`, build command `npm run build`, output directory `build`. Set `APP_NAME`, `API_URL=https://sayl-api.kitaaura.com` and `TURNSTILE_SITE_KEY`. Add the custom domain `sayl.kitaaura.com`.

### qBittorrent settings

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

## Tests

```sh
cd backend && npm install && npm test
```

## License

MIT. See [LICENSE](LICENSE).
