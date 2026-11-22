# Chain Sync Monitor

自托管的 CKB、Bitcoin、Blockbook 和 RGB++ SPV 同步面板。后端只通过 HTTP 读取上游：节点走 JSON-RPC，Blockbook 走 REST 状态接口。不使用容器 CLI、Docker socket 或日志，不需要外部数据库和前端构建。

[English](README.md)

## 部署在节点所在的 Linux 主机

```sh
mkdir -p config
cp config.example.toml config/config.toml
```

编辑 `config/config.toml`，填各服务的地址和 BTC RPC 用户名；密码分别写进 `config/` 下配置指定的文件。不需要的服务可以删除对应配置段。不要提交这个目录。镜像使用 UID/GID 65532，需要能进入目录并读到文件；建议用 ACL 或专用组授权，不要把密码文件设成全员可读。

如果 RPC 像示例一样只在宿主机的 localhost 监听：

```sh
docker compose -f compose.yaml -f compose.host.yaml up -d --build
```

在主机上打开 `http://127.0.0.1:8080`，或用 SSH 转发。此方式需要 Linux 的 host 网络及支持 `!reset` 的 Docker Compose。如果走 Docker bridge，改用 `docker compose up -d --build`，把上游地址填成容器能够访问的地址，例如同一共享 Docker 网络上的服务名。bridge 模式下容器里的 `127.0.0.1` 不是宿主机。

建议给 Bitcoin Core 配独立的 `rpcauth` 用户，再用 `rpcwhitelist=monitor:getblockchaininfo` 限权。共享节点加第一条白名单后，未列出的用户默认不能调用任何方法。保留原有策略：若已有用户应继续不受方法限制，设 `rpcwhitelistdefault=0`；否则为它们逐一列出需要的方法。改完确认 Blockbook 和 SPV 仍能连接。RPC 只走本机、私网或加密隧道。面板不自带登录。

## 用域名公开面板

把 [Caddyfile.example](Caddyfile.example) 的站点段加到宿主机 Caddy 配置，把 `monitor.example.com` 换成你的域名，配置 DNS 指向 Caddy 并开放 80/443 供证书签发。也可以用现有 HTTPS 反代，目标填 `127.0.0.1:8080`。只代理面板及其只读状态接口，不代理各节点的 RPC。面板继续监听本机；如果状态不打算公开，在反代上加认证。参见 [Caddy HTTPS 指南](https://caddyserver.com/docs/quick-starts/reverse-proxy#https-from-client-to-proxy)。

## 指标含义

- **CKB**：已验证高度、已知最佳区块头、未验证高度及内置索引高度。完整指标需要启用 `Net` 和 `Indexer` RPC 模块。
- **BTC**：已验证区块、区块头、估算验证百分比和初始同步状态。
- **Blockbook**：展示 `/api/` 返回的索引高度和同步状态，并与其 BTC 后端对比。bulk 导入期间接口可能暂不更新，不用日志值冒充已索引高度。
- **SPV**：RPC 有响应不代表已能生成证明。如需查看链上进度，在配置里填初始化交易某个 client/info 输出的**完整 type script**（`code_hash`、`hash_type`、`args`），不是该 script 的 hash。脚本经 CKB indexer 读取 info cell 指向的活跃 client。现有 SPV RPC 不返回本地缓存高度。落后量以配置的本地 BTC 节点为基准。

- **CKBadger**：可选，读取 `/api/v1/statistics/network` 的已索引高度、目标高度和深度分叉状态。启动时的 `503 initializing` 显示为同步中，直到返回有效状态前不计为可用。

通用 HTTP 探测用 GET，只有 2xx 计为可用，不跟随跳转。BTC Asset API 的 `/healthcheck` 反映依赖和 worker 的健康状态，不代表同步进度或 SPV 证明有效。主网 Blockbook 也是可选，配置方式与 Testnet3 相同。

## 可用率历史

24 小时和 7 天可用率按成功探测次数除以实际探测次数计算，不是连续 SLA。同步中的正常响应仍算可用；监控自身停机期间没有采样，不算在线也不算离线。Compose 用 `monitor-history` 卷保留约八天的 SQLite 历史，重启不会清空。非容器运行时，可用 `monitor.history_path` 覆盖默认的配置文件同目录数据库。

## CI

`python3 -m unittest discover -s tests -v` 运行测试。PR 只跑测试和构建；推到 `main` 时测试通过后，CI 向 GHCR 发布 `latest` 及 commit 标签。

GHCR 镜像公开后，同一组 Compose 文件也可以先 `pull`，再 `up -d --no-build`，不用本机编译镜像。
