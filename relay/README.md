# The relay

Browsers can't open TCP connections, so a BitTorrent client in a web page can't reach normal peers. The relay is a small Cloudflare Worker that does it for the page. Each WebSocket from the page becomes one TCP connection to a peer or a tracker, and the relay copies bytes both ways. All the torrent logic (pieces, hashes, metadata, PEX, the DHT) runs in the page, in [`../client`](../client).

```
browser (Sayl, in the page)          Cloudflare (free plan)                swarm
┌────────────────────────┐   WSS   ┌────────────────────────────┐  TCP  ┌────────────────┐
│ picks pieces, checks   │◄───────►│ relay: copies bytes, only  │◄─────►│ normal peers   │
│ SHA-1, gets metadata,  │         │ for BitTorrent handshakes, │       │ (qBittorrent,  │
│ PEX, DHT, saves files  │         │ tracker announces and TURN │       │ Transmission…) │
└────────────────────────┘         └────────────────────────────┘       └────────────────┘
```

Each person runs their own relay on their own free Cloudflare account. Their traffic goes through their account, not Sayl's.

## Set one up

The easy way: on the Sayl website, press **set up with cloudflare** and approve it. Sayl installs this relay on your account and fills in its address and token for you.

### By hand (about 5 minutes, free, no card)

You need Node.js 22 and a free Cloudflare account. In this folder:

```sh
npm install
npx wrangler login                        # opens the browser; approve it
npx wrangler deploy                       # prints https://sayl-relay.<your-subdomain>.workers.dev
npx wrangler secret put ACCESS_TOKEN      # any long random string (openssl rand -hex 16); keeps strangers off your relay
```

The first deploy may ask you to pick a `workers.dev` subdomain. Then open Sayl, paste the relay's address and the token, and you're done.

Updating later: `git pull`, then `npx wrangler deploy` here. Secrets are kept.

### The DHT (optional)

Without UDP, the relay can't reach the DHT directly, and Workers aren't allowed to connect to Cloudflare's own TURN servers. So the DHT goes through a TURN server at another provider. Sayl only uses it as a last resort, when trackers and PEX find no one. Each lookup is about 20 KB.

With [Metered](https://www.metered.ca)'s free plan (20 GB a month, no card), either:

- **a fixed login:** in Metered, *TURN Server → Credentials → Add Credential* (no expiry, no webhook). Then:

  ```sh
  npx wrangler secret put TURN_URLS        # turns:standard.relay.metered.ca:443?transport=tcp,turn:standard.relay.metered.ca:80?transport=tcp
  npx wrangler secret put TURN_USERNAME
  npx wrangler secret put TURN_CREDENTIAL
  ```

- **or logins made on demand** (they expire after 2 hours), if your plan has API access:

  ```sh
  npx wrangler secret put METERED_APP          # the part before .metered.live
  npx wrangler secret put METERED_SECRET_KEY
  ```

`TURN_HOSTS` in `wrangler.toml` lists the TURN servers the relay may reach. If yours isn't covered, add it there before deploying.

If the TURN server is missing, out of quota or refusing logins, downloads carry on without the DHT.

## What it carries, and nothing else

The relay must not become a free proxy, so it only carries:

- **BitTorrent connections.** The page must open with a BitTorrent handshake, and the remote must answer with one before anything else passes, in either direction.
- **One tracker announce per tunnel.** A single `GET …announce…?…info_hash=…` request and nothing after it.
- **TURN,** and only to the hosts in `TURN_HOSTS`.

It also refuses private and local addresses and mail ports. With `ACCESS_TOKEN` set, it refuses anyone without the token.

Peers see Cloudflare's addresses, not the person's. What passes through a relay is the responsibility of whoever runs it, under Cloudflare's terms.

## Endpoints

| Path | What it does |
|---|---|
| `GET /tunnel?host=…&port=…[&tls=1][&via=do&session=…][&token=…]` | WebSocket ⇄ TCP. `via=do` runs it in a Durable Object shared by one download (Sayl's default). |
| `GET /turn-credentials[?token=…]` | A TURN login for the DHT, or an empty list and the reason. |
| `GET /health` | `{"status":"ok"}` |

## Measured on the real internet

From a Mac, through a deployed relay on the free plan:

| Test | Result |
|---|---|
| Worker relay, Debian ISO | 20 MB/s |
| Durable Object relay | 17 MB/s |
| Full ISO | SHA-256 matches Debian's |
| Bare magnet, trackers only | 17 MB/s |
| Bare magnet, DHT only (Metered TURN) | 385 peers found, 10 MB/s |
| In Chrome | 18.5 MB/s |

About 2,000–5,000 relay messages per GB. Durable Objects bill incoming messages at 20 per request, so the free plan's 100,000 requests a day cover several hundred GB a day.

## Tools

```sh
# download through a relay from the command line, and print what happened
node cli/fetch.mjs --relay $RELAY --token $TOKEN --debian --limit-mb 300 [--via do] [--out file] [--magnet …] [--no-dht]
# check the DHT path step by step: TURN login, connection, allocation, lookup, download
node cli/turn-check.mjs --relay $RELAY --token $TOKEN
```

## Tests

```sh
npm test                                         # what the relay agrees to carry
npm install --no-save playwright-core@1.56.1     # for the website test
node test/local.mjs      # relay + client against a real qBittorrent (Docker), with coturn for the DHT if installed
node test/website.mjs    # the Sayl website in browser mode, in Chromium, against the same setup
node test/setup.mjs      # "set up with cloudflare": sign-in, upload, workers.dev, against a stand-in Cloudflare
```

`local.mjs` downloads through the relay in every mode and checks: refusals, file choice, sequential order, resuming, the DHT as the last resort, and a refused TURN login. `website.mjs` goes through the site like a person: set the relay, add a magnet and a `.torrent`, pick files, save them and compare them byte for byte, recheck, pause and resume, reload mid-download, and remove.
