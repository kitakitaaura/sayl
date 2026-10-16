# Experiment: Sayl without a server

The question: can the browser itself be the BitTorrent client, with Cloudflare's free plan only carrying its connections? If yes, Sayl needs no VPS, no disk and no money.

```
browser (this client)                Cloudflare (free plan)               swarm
┌────────────────────────┐   WSS   ┌────────────────────────────┐  TCP  ┌────────────────┐
│ picks pieces, checks   │◄───────►│ relay: copies bytes, only  │◄─────►│ normal peers   │
│ SHA-1, gets metadata,  │         │ for BitTorrent handshakes  │       │ (qBittorrent,  │
│ PEX, writes to disk    │         │ and tracker announces      │       │ Transmission…) │
└────────────────────────┘         └────────────────────────────┘       └────────────────┘
```

Browsers can't open TCP connections; Workers can (`connect()`). So the relay turns each WebSocket from the page into one TCP connection to a peer or tracker. All the torrent logic runs in the page.

This folder is separate from Sayl. Nothing in `backend/` or `frontend/` uses it.

## What's here

| Path | What it is |
|---|---|
| `worker/index.js` | the relay: a Worker, plus a Durable Object version of the same relay |
| `worker/policy.js` | what the relay agrees to carry (see *Abuse* below) |
| `public/client/` | the BitTorrent client: peer protocol, metadata from magnets, PEX, HTTP trackers, piece picking, SHA-1 checks. Plain JS, runs in browsers and Node 22 |
| `public/index.html` | a test page, served by the relay itself |
| `cli/fetch.mjs` | the same client from the command line, for measuring |
| `cli/turn-check.mjs` | checks that the DHT can be reached through the relay and TURN |
| `test/` | unit tests, and an end-to-end test against a real qBittorrent |

## What's proven so far

Tested here on one machine, with no internet:

- A real qBittorrent 5.2.4 seeds a 40 MB file. The relay runs in `wrangler dev`, the local version of Cloudflare's runtime.
- The client downloads the file through the relay and the SHA-256 matches. This works:
  - from a .torrent and from a magnet (metadata fetched from the peer);
  - through the Worker relay and through the Durable Object relay;
  - from Node, from the command-line tool, and from the test page in Chromium.
- The relay refuses traffic that isn't BitTorrent: other bytes, other HTTP requests, a remote that doesn't answer like a peer, and a second request on a tracker tunnel.
- About 1,900 relay messages per GB downloaded. That matters for Durable Object billing (see below).

What this can't show: how Cloudflare's **real** free-plan limits treat it, and how many **real** peers are reachable. The sandbox I built this in can't reach the BitTorrent network at all. That's the next test, and you run it.

## Run the real test (about 15 minutes)

On your Mac, in this folder:

```sh
cd experiments/relay
npm install
npx wrangler login            # opens the browser; log in to your Cloudflare account
npx wrangler deploy           # prints https://sayl-relay.<your-subdomain>.workers.dev
npx wrangler secret put ACCESS_TOKEN    # type any long random string; keeps strangers off the relay
```

Then measure, with `RELAY=https://sayl-relay.<your-subdomain>.workers.dev` and `TOKEN=` the string you typed:

```sh
# 1. Worker relay, 300 MB of the Debian ISO
node cli/fetch.mjs --relay $RELAY --token $TOKEN --debian --limit-mb 300

# 2. Durable Object relay, same thing
node cli/fetch.mjs --relay $RELAY --token $TOKEN --debian --limit-mb 300 --via do

# 3. The whole ISO through whichever was faster, checked against Debian's SHA-256
node cli/fetch.mjs --relay $RELAY --token $TOKEN --debian --via do --out debian.iso

# 4. A magnet with no trackers of its own, like many real ones
#    (use the info hash printed by test 1)
node cli/fetch.mjs --relay $RELAY --token $TOKEN --via do --magnet "magnet:?xt=urn:btih:<info hash>" --limit-mb 100
```

Each run prints progress, then a JSON summary. Also open `$RELAY/?token=$TOKEN` in Chrome and try a magnet in the page.

Then look at the Cloudflare dashboard → **Workers & Pages → sayl-relay → Metrics** (errors, CPU time) and **Durable Objects** (duration in GB-s). Paste the four summaries and those numbers back to me.

## What decides it

| Result | Means |
|---|---|
| Test 1 finishes at a few MB/s with no "exceeded CPU" errors | The plain Worker relay works on the free plan. Best case. |
| Test 1 dies after a few MB, with CPU-limit errors in the dashboard | Free Workers get only 10 ms of CPU per request. Expected; we use the Durable Object relay instead. |
| Test 2 finishes at a few MB/s | The Durable Object relay works. Free plan: about 28 relay-hours a day across all users (13,000 GB-s ÷ 128 MB), and about 100 billed requests per GB (1,900 messages ÷ 20). |
| Test 3 says `"sha256": "match"` | End to end, byte for byte, over the real internet. |
| Test 4 finds peers | Magnets work without DHT, through opentrackr and PEX. |
| `peersTried` is high but `peersHandshaken` is low | Many peers refuse unencrypted connections or are unreachable. Encryption (MSE) can be added to the client. |
| Every test fails to connect | Cloudflare blocks this kind of traffic. The idea is dead; back to a VPS. |

## How peers are found

In this order, stopping as soon as there are peers to talk to:

1. **The torrent's own trackers**, and **about 25 public HTTP(S) trackers** for every torrent. The list comes from [ngosang/trackerslist](https://github.com/ngosang/trackerslist), fetched fresh each time, with a bundled copy as the fallback. udp:// trackers are also tried over HTTP on the same port.
2. **PEX**: connected peers tell us about others.
3. **The DHT, only as a last resort**: when, after 15 seconds, there's no peer connected, none being connected and none left to try. At most once every 10 minutes per download.

### The DHT, through TURN

Workers have no UDP and can't reach Cloudflare's own TURN servers (tested). So the DHT goes through the operator's TURN account at another provider, and users never see it:

```
browser ── relay (TCP) ── TURN server (operator's free account) ── UDP ──► DHT nodes
```

- The relay hands the browser a short-lived login (`/turn-credentials`). The account's secret key stays in the relay.
- A lookup is about 20 KB, so Metered's free 20 GB a month covers roughly a million lookups.
- **It fails safe.** If there's no TURN account, the quota is used up, the login is refused or the server is down, the download carries on with trackers and PEX. A refused login switches the DHT off for an hour, so a dead account isn't retried on every download.

Set it up with Metered (free, no card):

1. Sign up at metered.ca on the **Free (20 GB)** plan and create an app. Note the **app name** (the part before `.metered.live`) and, under the developer or API settings, the **secret key**.
2. In this folder:

```sh
npx wrangler secret put METERED_APP
npx wrangler secret put METERED_SECRET_KEY
npx wrangler deploy
```

If the free plan has no API access, use a fixed login from the Metered dashboard instead: `npx wrangler secret put` for `TURN_URLS` (e.g. `turns:standard.relay.metered.ca:443?transport=tcp`), `TURN_USERNAME` and `TURN_CREDENTIAL`.

3. Check it, then try a bare magnet with no trackers at all:

```sh
node cli/turn-check.mjs --relay $RELAY --token $TOKEN
node cli/fetch.mjs --relay $RELAY --token $TOKEN --via do --no-extra-trackers --magnet "magnet:?xt=urn:btih:7acf8fb590b2060dd9c3146ef770169d593433b0" --limit-mb 50
```

The second one has no tracker to ask, so peers can only come from the DHT. Its summary should say `"dht": "found … peers"`.

## Known limits

- **The DHT needs a TURN account** (see above). Without one, torrents whose peers are only in the DHT won't start.
- **No uploading yet.** The client only downloads. Seeding would only work while the tab is open, and only to peers we connect to.
- **No encryption (MSE) yet.** Peers that require it will refuse us.
- **One file out.** Multi-file torrents are saved as one joined file. Splitting them is a Sayl-frontend job.
- **Chrome and Edge save straight to disk.** Other browsers keep the file in memory, up to 1 GB.

## Abuse

The relay must not become a free proxy for anything else, so it only carries:

- **BitTorrent connections.** The page must send a BitTorrent handshake first, and the remote must answer with one before anything else passes, in either direction.
- **One tracker announce per tunnel.** A single `GET …announce…?…info_hash=…` request and nothing after it.

It also refuses private and local addresses and mail ports, and `ACCESS_TOKEN` keeps strangers off it.

Peers see Cloudflare's addresses, not users'. Copyright complaints about what people download would therefore go to Cloudflare, which could suspend the account. That's the main risk of running this publicly.

## Tests

```sh
npm test                                    # unit tests
npm install --no-save playwright-core@1.56.1   # optional, adds the browser check
node test/local.mjs                         # end to end; needs Docker and linuxserver/qbittorrent:5.2.4 (and coturn for the DHT part)
```
