# Chain Sync Monitor

A small, self-hosted dashboard for CKB and Bitcoin nodes, Blockbook and RGB++ SPV. It polls upstreams over HTTP only, using JSON-RPC where available and Blockbook's REST status endpoint. No Docker socket, node CLI, log scraping, external database or JavaScript build.

[中文](README.zh-CN.md)

## Run on the same Linux host as the nodes

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

## Publish the dashboard on your domain

Copy the block from [Caddyfile.example](Caddyfile.example) into your host's Caddy configuration and replace `monitor.example.com` with your hostname. Point the domain's DNS at Caddy and allow certificate issuance on ports 80/443. Other HTTPS reverse proxies can use the same destination, `127.0.0.1:8080`. Only the dashboard and its read-only status JSON are proxied; upstream RPC settings stay in `config/config.toml`. Leave the monitor on loopback, and add proxy authentication if the status is not meant to be public. See [Caddy's HTTPS guide](https://caddyserver.com/docs/quick-starts/reverse-proxy#https-from-client-to-proxy).

## What the figures mean

- **CKB:** verified tip vs best known header, unverified tip, and built-in indexer height. Enable the `Net` and `Indexer` RPC modules for all metrics.
- **BTC:** validated blocks, headers, verification estimate and initial block download status.
- **Blockbook:** index height and sync flag from `/api/`, compared to its Bitcoin backend. During bulk import, the reported height can lag; no log-based estimate is presented as committed progress.
- **SPV:** proof RPC responsiveness is not proof availability. To track on-chain progress, configure the full instance **type script** (`code_hash`, `hash_type`, `args`) from a client or info output in the SPV initialization transaction. Do not paste the hash of that script instead. The monitor reads the active client selected by the info cell through CKB's indexer. The existing SPV RPC does not expose its local cache tip. SPV lag is relative to the configured local BTC node, not to an external chain tip.

- **CKBadger:** optionally query its `/api/v1/statistics/network` for indexed/target heights and deep-fork status. Startup `503 initializing` shows as syncing but does not count as available until the endpoint returns usable data.

Generic HTTP checks use a configured GET URL and count 2xx as available without following redirects. BTC Asset API's `/healthcheck` measures dependency and worker health, not sync progress or SPV proof validity. Mainnet Blockbook is optional and configured the same way as testnet3.

## Availability history

The 24-hour and 7-day figures are successful probes divided by observed probes, not a continuous SLA. Syncing can count as available. Time the monitor itself was down is unobserved and excluded; the UI shows sample counts. Compose stores roughly eight days in the `monitor-history` volume, which survives restarts; don't remove the volume if you want to keep the data. For a non-container run, set `monitor.history_path` to override the database next to the config file.

## CI

`python3 -m unittest discover -s tests -v` runs the tests. Pull requests test and build the container without publishing. Pushes to `main` test then publish `latest` and a commit tag to GHCR.

Once the GHCR image is public, replace `up -d --build` with `pull` followed by `up -d --no-build` using the same Compose files.
