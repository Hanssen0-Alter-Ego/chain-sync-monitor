# Chain Sync Monitor

用 TypeScript 编写的链同步监控。前端是静态面板，后端用 Node.js 定时请求 JSON-RPC 或 HTTP，将 uptime 样本存进 SQLite。无需 Docker Socket、节点 CLI 或额外数据库。

界面按浏览器的语言偏好显示简体中文或英文，不支持的语言回退到英文。

## 一起部署

```sh
mkdir -p config
cp config.example.toml config/config.toml
# 修改配置，填写节点地址；移除不需要的探测项。
docker compose up -d --build
```

访问 `http://127.0.0.1:8080`。默认是 bridge 网络，探测地址必须能从容器访问，容器内的 `127.0.0.1` 不是宿主机。如果服务只监听同一台 Linux 宿主机的回环地址，可以选用 `docker compose -f compose.yaml -f compose.host.yaml up -d --build`。同域反代示例：[Caddyfile.example](Caddyfile.example)。

## 前端放 Netlify，后端单独部署

1. 后端把各服务的 `url` 指向它能访问的私网、VPN 地址或加密隧道。不要把节点 RPC 暴露到公网；Bitcoin RPC 的 Basic Auth 不加密。密钥、RPC 地址和 uptime 库只放后端；容器 UID/GID 65532 需可读配置与对应凭据文件。
2. 把 `cors_origins = ["https://status.example.com"]` 加入已有的 `[monitor]`，填写实际的前端 origin。后端运行 `MONITOR_API_ONLY=1 docker compose up -d --build`。参考 [Caddyfile.api.example](Caddyfile.api.example)，通过 HTTPS 只反代 `/api/status`。可用 `curl -i -H 'Origin: https://status.example.com' https://status-api.example.com/api/status` 检查。
3. 在 Netlify 导入仓库，根目录保持默认；Build 环境变量设置 `STATUS_API_URL=https://status-api.example.com/api/status`。[netlify.toml](netlify.toml) 会只构建前端并发布 `dist/web`。需要跨域访问的预览地址也要显式加入 CORS 列表。不要把 RPC URL 或密码填进 Netlify。
4. 可选：在各服务配置加 `public_url`，卡片标题就会链接到该公开地址，不使用探测用的 `url`。

浏览器只请求后端缓存的状态，不直接请求节点。CORS 不是认证；能访问状态 API 的人都能看到公开的服务状态。私有面板可把前后端放在同一个有认证的反代后面。

## 指标和历史

- CKB：已验证高度、已知高度、Indexer；BTC：已验证高度、区块头、IBD。
- Blockbook：索引高度和同步标记，跟配置的 BTC Core 对比；支持分别配置主网和 Testnet3。
- SPV：默认只探测证明 RPC；配置实例的完整 `type_script` 后，也可通过 CKB Indexer 读链上高度，不把它当成本地缓存高度。
- CKBadger：双网部署分别用 `/api/mainnet/v1/statistics/network` 与 `/api/testnet/v1/statistics/network`；单网独立部署用 `/api/v1/statistics/network`。
- BTC Asset API 等 HTTP 服务：按 2xx 判断可用，不跟随重定向，不显示链同步进度。

24 小时、7 天可用率按实际探测样本计算；同步中不等于不可用，监控停机也不算节点停机。升级时可保留原 TOML 与 Compose 的 `monitor-history` 卷（SQLite 格式不变），不要让旧、新两个监控进程同时写同一个库。

本地用 Node.js 24，执行 `npm ci && npm test`。PR 跑测试并构建 Docker；`main` 测试通过会发布 GHCR 镜像。
