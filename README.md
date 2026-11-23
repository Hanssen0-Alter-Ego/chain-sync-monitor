# Chain Sync Monitor

A small, self-hosted dashboard for CKB and Bitcoin nodes, Blockbook and RGB++ SPV. It polls upstreams over HTTP only, using JSON-RPC where available and Blockbook's REST status endpoint. TypeScript on both sides: a static browser dashboard and a long-running Node.js backend with local SQLite. No Docker socket, node CLI, log scraping or external database.

[中文](README.zh-CN.md)

The dashboard follows the browser’s language preferences (English or Simplified Chinese, with English as the fallback).

## Run with Docker

```sh
mkdir -p config
cp config.example.toml config/config.toml
```

Edit `config/config.toml`. In the default example, mainnet/testnet CKB use ports 8114/8116, BTC 8332/18332, SPV 8888/8889 and testnet3 Blockbook 19130. Remove service sections you don't need. For Bitcoin Core, set the RPC user and create the configured password files under `config/`. Never commit this directory. The container runs as UID/GID 65532, which needs read access to those files and traversal access to the directory; use a narrow ACL or group, not world-readable passwords.

If your nodes already publish on the host loopback (as in the example):

```sh
docker compose -f compose.yaml -f compose.host.yaml up -d --build
```

Open `http://127.0.0.1:8080` on that host, or forward it over SSH. The override needs Linux host networking and Docker Compose with support for `!reset`. If the monitor uses a Docker bridge instead, use `docker compose up -d --build` and configure upstream URLs reachable from that container, such as service DNS names on a shared Docker network. The container's `127.0.0.1` is not the host's loopback in bridge mode.

Use a dedicated Bitcoin Core RPC user with `rpcauth` and `rpcwhitelist=monitor:getblockchaininfo`. On a shared node, adding the first whitelist denies all methods to unlisted users by default. Preserve your existing policy: use `rpcwhitelistdefault=0` if existing users should retain unrestricted RPC access, or explicitly allowlist their required methods. Verify Blockbook and SPV still connect after the change. Keep RPC on loopback, a private network, or an encrypted tunnel. The dashboard has no built-in login.

## Deploy the frontend to Netlify and the backend separately

```text
Browser → Netlify (static UI)
Browser → https://status-api.example.com/api/status (cached public snapshot)
Monitor backend → private/TLS CKB, Bitcoin Core, Blockbook, SPV, CKBadger, and HTTP endpoints
```

1. On the backend machine, configure each service’s `url` using an address reachable **from the monitor container**. For a different host, use a private/VPN address or an authenticated encrypted tunnel; don't publish node RPCs to the internet. Bitcoin RPC Basic auth is not encryption. Netlify and browsers never need a route to the nodes.
2. In backend `config/config.toml`, add `cors_origins = ["https://status.example.com"]` to the existing `[monitor]` table (use the actual dashboard origin, including the default `.netlify.app` name if you use it). Run `MONITOR_API_ONLY=1 docker compose up -d --build` to serve just the JSON API.
3. Point an HTTPS hostname at the backend reverse proxy. [Caddyfile.api.example](Caddyfile.api.example) proxies only `/api/status` to `127.0.0.1:8080`. Use `curl -i -H 'Origin: https://status.example.com' https://status-api.example.com/api/status` to check the JSON and matching `Access-Control-Allow-Origin`.
4. Import the repository into Netlify without changing the base directory. Set the build variable `STATUS_API_URL=https://status-api.example.com/api/status`; [netlify.toml](netlify.toml) builds frontend only and publishes `dist/web`. The URL is public; don't put credentials or node addresses in Netlify. For a preview on a different origin, explicitly add that origin or use the production dashboard to check connectivity.

CORS controls browser access; it is not authentication. Anyone who can reach the public status URL can read the returned labels, heights and uptime. For a private dashboard, co-host the frontend and backend behind the same authenticated proxy, or use a private network.

Use `public_url` on a service if its card should link to a public site. It's separate from the probe `url`, deliberately published, and does not affect what the backend polls.

## Publish a co-hosted dashboard on your domain

Copy the block from [Caddyfile.example](Caddyfile.example) into your host's Caddy configuration and replace `monitor.example.com` with your hostname. Point the domain's DNS at Caddy and allow certificate issuance on ports 80/443. Other HTTPS reverse proxies can use the same destination, `127.0.0.1:8080`. Only the dashboard and its read-only status JSON are proxied; upstream RPC settings stay in `config/config.toml`. Leave the monitor on loopback, and add proxy authentication if the status is not meant to be public. See [Caddy's HTTPS guide](https://caddyserver.com/docs/quick-starts/reverse-proxy#https-from-client-to-proxy).

## What the figures mean

- **CKB:** verified tip vs best known header, unverified tip, and built-in indexer height. Enable the `Net` and `Indexer` RPC modules for all metrics.
- **BTC:** validated blocks, headers, verification estimate and initial block download status.
- **Blockbook:** index height and sync flag from `/api/`, compared to its Bitcoin backend. During bulk import, the reported height can lag; no log-based estimate is presented as committed progress.
- **SPV:** proof RPC responsiveness is not proof availability. To track on-chain progress, configure the full instance **type script** (`code_hash`, `hash_type`, `args`) from a client or info output in the SPV initialization transaction. Do not paste the hash of that script instead. The monitor reads the active client selected by the info cell through CKB's indexer. The existing SPV RPC does not expose its local cache tip. SPV lag is relative to the configured local BTC node, not to an external chain tip.

- **CKBadger:** query `/api/mainnet/v1/statistics/network` and `/api/testnet/v1/statistics/network` for a shared frontend, or `/api/v1/statistics/network` for a standalone instance, to get indexed/target heights and deep-fork status. Startup `503 initializing` shows as syncing but does not count as available until the endpoint returns usable data.

Generic HTTP checks use a configured GET URL and count 2xx as available without following redirects. BTC Asset API's `/healthcheck` measures dependency and worker health, not sync progress or SPV proof validity. Mainnet Blockbook is optional and configured the same way as testnet3.

## Availability history

The 24-hour and 7-day figures are successful probes divided by observed probes, not a continuous SLA. Syncing can count as available. Time the monitor itself was down is unobserved and excluded; the UI shows sample counts. Compose stores roughly eight days in the `monitor-history` volume, which survives restarts; don't remove the volume if you want to keep the data. For a non-container run, set `monitor.history_path` to override the database next to the config file. An existing Python deployment can reuse the same config and SQLite database/Compose volume; stop the old monitor before starting the new one. The host-mode override is still supported.

## Local development and CI

Node.js 24 and npm are required. Run `npm ci` and `npm test` to build the frontend and backend and run integration tests against local stubbed upstreams. `npm run build:frontend` builds just the static site; `npm run build:backend` builds just the monitor. To run locally after `npm run build`: `npm start -- --config config/config.toml`. Pull requests test and build the container without publishing. Pushes to `main` test then publish `latest` and a commit tag to GHCR.

Once the GHCR image is public, replace `up -d --build` with `pull` followed by `up -d --no-build` using the same Compose files.
