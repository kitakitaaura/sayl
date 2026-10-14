# Deploying Sayl

This puts Sayl online for free:

| Address | What runs there |
|---|---|
| `sayl.kitaaura.com` | the website, on Cloudflare Pages |
| `sayl-api.kitaaura.com` | the API, on your Oracle VM, reached through a Cloudflare Tunnel |
| `sayl-dl.kitaaura.com` | file downloads, straight from the VM (Caddy, HTTPS from Let's Encrypt) |

Budget about an hour. Cloudflare and Oracle rename menus now and then; if a label below doesn't match exactly, look for the nearest equivalent.

**You need:** the `kitaaura.com` domain on Cloudflare, an Oracle Cloud account (a card is needed to sign up; Always Free resources aren't charged), an SSH key (`ssh-keygen -t ed25519` if you don't have one), and this repo on GitHub.

---

## 1. Create the Oracle VM

1. In the Oracle Cloud console: **Compute → Instances → Create instance**.
2. **Image:** Canonical Ubuntu 24.04. **Shape:** *Ampere* → `VM.Standard.A1.Flex`, 2 OCPUs and 12 GB memory (Always Free covers up to 4 OCPUs and 24 GB in total).
3. **Networking:** create a new virtual cloud network with a public subnet, and keep *Assign a public IPv4 address* on.
4. **SSH keys:** paste your public key (`~/.ssh/id_ed25519.pub`).
5. **Boot volume:** tick *Specify a custom boot volume size* and enter **180 GB**. Always Free includes 200 GB of block storage in total. Sayl's default caps (120 GB of downloads, 2 GB always kept free) fit inside this.
6. Create it. If you get *Out of capacity*, try another availability domain, or try again later; free ARM capacity comes and goes.

Note the VM's **public IP address**, then connect:

```sh
ssh ubuntu@<public-ip>
```

## 2. Open the ports

Oracle blocks ports in two places, and both need opening.

**a. The cloud firewall.** Open the VM's subnet → its **security list** → **Add ingress rules**, source `0.0.0.0/0`, one rule per line:

| Protocol | Port | For |
|---|---|---|
| TCP | 80 | Let's Encrypt certificate checks |
| TCP | 443 | downloads (HTTPS) |
| UDP | 443 | downloads over HTTP/3 |
| TCP | 6881 | BitTorrent peers |
| UDP | 6881 | BitTorrent peers (DHT, uTP) |

Port 22 (SSH) is already open. The API needs no open port: the tunnel connects outwards.

**b. The VM's own firewall.** Oracle's Ubuntu images reject everything except SSH. On the VM, **before installing Docker**:

```sh
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 443 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 6881 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 6881 -j ACCEPT
sudo netfilter-persistent save
```

Saving before Docker is installed matters: Docker adds its own rules at every start, and they shouldn't be saved into the boot rules.

*IPv6 (optional).* Peers can also reach you over IPv6 if you add an IPv6 prefix to the VCN and subnet, give the VM's network card an IPv6 address, add the same ingress rules with source `::/0`, and repeat the commands above with `ip6tables`. Sayl works without it.

## 3. Install Docker

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```

Log back in (`ssh ubuntu@<public-ip>`) so the group change applies, then check: `docker compose version`.

## 4. Set up Cloudflare

All of this is in the Cloudflare dashboard for `kitaaura.com`.

**a. The download address (DNS only).** **DNS → Records → Add record**: type `A`, name `sayl-dl`, IPv4 address = the VM's public IP, and switch **Proxy status off** (grey cloud, *DNS only*). Downloads must not go through Cloudflare's proxy: serving large files that way breaks Cloudflare's terms on the free plan.

**b. The tunnel for the API.** Open **Zero Trust → Networks → Tunnels → Create a tunnel** → *Cloudflared* → name it `sayl`. On the install page, choose *Docker* and copy the long token after `--token` in the command shown. You'll paste it into `.env` as `TUNNEL_TOKEN`. Then add a **public hostname**:

| Field | Value |
|---|---|
| Subdomain | `sayl-api` |
| Domain | `kitaaura.com` |
| Service type | `HTTP` |
| URL | `backend:8080` |

`backend` is the API's name inside Docker; cloudflared runs next to it.

**c. Turnstile (the captcha).** **Turnstile → Add widget**: name `sayl`, hostname `sayl.kitaaura.com`, mode *Managed*. Keep both keys: the **site key** goes to Pages (step 6), the **secret key** into `.env` (step 5). You can skip this for now and leave both empty; the captcha is then off.

## 5. Install Sayl on the VM

```sh
git clone https://github.com/kitakitaaura/sayl.git
cd sayl
cp .env.example .env
```

If the repo is private, make it public (it's open source) or clone with a GitHub token.

Fill in the secrets:

```sh
sed -i "s/^QBIT_PASSWORD=.*/QBIT_PASSWORD=$(openssl rand -hex 16)/" .env
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^DOWNLOAD_URL_SECRET=.*/DOWNLOAD_URL_SECRET=$(openssl rand -hex 32)/" .env
```

Then open `.env` (`nano .env`) and check or set:

| Setting | Value |
|---|---|
| `COMPOSE_PROFILES` | `public` |
| `FRONTEND_ORIGIN` | `https://sayl.kitaaura.com` (exactly, no trailing slash) |
| `DL_DOMAIN` | `sayl-dl.kitaaura.com` |
| `TUNNEL_TOKEN` | the token from step 4b |
| `TURNSTILE_SECRET_KEY` | the secret key from step 4c, or empty |
| `ACCESS_CODE` | a code for your beta testers, or empty for public |

Start everything:

```sh
docker compose up -d --build --wait
docker compose exec backend sayl-admin status
```

`status` should end with **settings match .env**. Then check the two public addresses, from your own computer:

```sh
curl https://sayl-api.kitaaura.com/api/health    # {"app":"Sayl","status":"ok"}
curl https://sayl-dl.kitaaura.com/dl/health      # {"status":"ok"}
```

The first request to `sayl-dl` can take half a minute while Caddy gets its certificate. If it fails, see *Troubleshooting* below.

## 6. Put the website on Cloudflare Pages

1. **Workers & Pages → Create → Pages → Connect to Git**, and pick the `sayl` repo.
2. Build settings:

   | Field | Value |
   |---|---|
   | Production branch | `main` |
   | Framework preset | None |
   | Build command | `npm run build` |
   | Build output directory | `build` |
   | Root directory | `frontend` |

3. Environment variables (production):

   | Variable | Value |
   |---|---|
   | `API_URL` | `https://sayl-api.kitaaura.com` |
   | `SITE_URL` | `https://sayl.kitaaura.com` |
   | `TURNSTILE_SITE_KEY` | the site key from step 4c, or leave it out |

4. Save and deploy. Then **Custom domains → Set up a custom domain** → `sayl.kitaaura.com`.

Pages rebuilds the site on every push to `main`. After changing a variable, start a new deployment (**Deployments → … → Retry deployment**) so the build picks it up.

## 7. Test it

Open `https://sayl.kitaaura.com`, enter the access code if you set one, and add something.

For a full check from your own computer (it downloads the current Debian netinst ISO through the server, checks the download link, then removes it):

```sh
node scripts/smoke.mjs https://sayl-api.kitaaura.com --code <your access code>
```

Add `--full` to also download the whole ISO and compare it with Debian's published SHA-256. If the captcha is on, the script can't pass it: open the site in a browser, copy the `sayl_sid` cookie for `sayl-api.kitaaura.com` (dev tools → Application → Cookies), and add `--cookie "sayl_sid=…"`.

`sayl-admin status` on the VM shows the connection state: **connected** means peers can reach the VM on port 6881; **firewalled** means downloads still work, but more slowly, so recheck step 2.

## 8. Going public

When the beta is over, set `ACCESS_CODE=` (empty) in `.env` and run `docker compose up -d --wait`. Keep Turnstile on to keep bots out.

---

## Running it

**Update** after pushing changes:

```sh
cd ~/sayl && git pull && docker compose up -d --build --wait
```

The website updates on its own through Pages.

**Logs:** `docker compose logs -f backend` (or `qbittorrent`, `caddy`, `cloudflared`).

**Takedowns:** when a notice comes in, find the torrent and block it:

```sh
docker compose exec backend sayl-admin list --ips
docker compose exec backend sayl-admin block <hash> "notice from … on …"
```

This deletes it for everyone and stops anyone adding it again. For repeat abuse from one address: `sayl-admin ban-ip <ip> "reason" --purge`. In the US, the DMCA safe harbor also expects a registered agent with the Copyright Office; this isn't legal advice, so check what applies where you are.

**Disk:** `df -h /` on the VM. Sayl keeps downloads within `GLOBAL_STORAGE_CAP_GB` and leaves `DISK_RESERVE_GB` free, and deletes files on the retention timers.

**Nothing needs backing up.** The database only tracks torrents that delete themselves within a day; settings are in `.env`. Keep a copy of `.env` somewhere safe.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `sayl-api…/api/health` doesn't answer | Tunnel not connected: check `docker compose logs cloudflared`, the token, and that the public hostname points to `backend:8080` (HTTP). |
| `sayl-dl…` has no certificate | Port 80 or 443 is closed (step 2, both places), or the `sayl-dl` record is proxied (it must be DNS only), or DNS hasn't updated yet. See `docker compose logs caddy`. |
| The site loads but says it can't reach Sayl | `API_URL` in Pages is wrong or wasn't rebuilt, or `FRONTEND_ORIGIN` in `.env` doesn't match the site address exactly. |
| Requests fail with "requests from other sites are not allowed" | `FRONTEND_ORIGIN` doesn't match. |
| "the captcha isn't set up on this site yet" | `TURNSTILE_SECRET_KEY` is set on the VM but `TURNSTILE_SITE_KEY` isn't set in Pages (or Pages wasn't redeployed). |
| `status` says **firewalled** | Port 6881 TCP/UDP isn't open in both firewalls. |
| Seeding uploads almost nothing | Run `sayl-admin peers <hash>` (the hash is the first column of `sayl-admin list`) after a few minutes of seeding something popular. Peers marked `I` connected to you; if none ever do, port 6881 isn't reachable from outside (step 2). Peers marked `U` are receiving data. Very popular torrents with many seeds and few downloaders upload little even when everything works. |
| `docker compose up` fails with an IPv6 error | Set `ENABLE_IPV6=false` in `.env`. |
| Everyone gets "your network already has…" | Your testers share one address: raise `MAX_ACTIVE_PER_IP` and `MAX_STORAGE_PER_IP_GB`. |

## Renaming

Change `name` in `brand.json` (or set `APP_NAME` in `.env` and in Pages), then redraw the share image:

```sh
cd frontend
npm install --no-save playwright@1.56.1
npx playwright install chromium
node scripts/make-images.mjs
```

Commit the new images in `frontend/static/`.
