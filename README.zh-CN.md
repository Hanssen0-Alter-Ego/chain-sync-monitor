# Chain Sync Monitor

用 TypeScript 编写的链同步监控。前端是静态面板，后端用 Node.js 定时请求 JSON-RPC 或 HTTP，将 uptime 样本存进 SQLite。无需 Docker Socket、节点 CLI 或额外数据库。

面板默认跟随浏览器语言；也可在语言菜单选择简体中文、繁體中文、日语、法语、德语或英文，手动选择会记在浏览器里。

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
3. 在 Netlify 导入仓库，根目录保持默认；Build 环境变量设置 `STATUS_API_URL=https://status-api.example.com/api/status`。[netlify.toml](netlify.toml) 会只构建前端并发布 `dist/web`。在 `[monitor]` 设置 `cors_netlify_site = "chain-sync-monitor"`（换成你的 Netlify 站点名），即可放行该站点的默认域名和按部署 ID 生成的[固定链接](https://docs.netlify.com/deploy/deploy-overview/)，无需逐个添加。PR 预览地址、分支部署地址和自定义域名仍须显式加入 `cors_origins`。不要把 RPC URL 或密码填进 Netlify。
4. 可选：在各服务配置加 `public_url`，卡片标题就会链接到该公开地址，不使用探测用的 `url`。

浏览器只请求后端缓存的状态，不直接请求节点。CORS 不是认证；Netlify 设置只匹配 Origin 格式，不验证部署归属。能访问状态 API 的人都能看到公开的服务状态。私有面板可把前后端放在同一个有认证的反代后面。

## 指标和历史

- CKB：已验证高度、已知高度、Indexer；BTC：已验证高度、区块头、IBD。
- Blockbook：索引高度和同步标记，跟配置的 BTC Core 对比；支持分别配置主网和 Testnet3。
- SPV：支持 `getSyncStatus` 的服务会显示缓存的 BTC 高度、本地头高度和最近确认的链上客户端高度，附可用的观测时间。缓存不等于独立验证同步。可选填完整实例 `type_script` 通过 CKB Indexer 核验链上高度；配置的 Bitcoin Core 高度优先。旧版证明 RPC 仍可用。 可配 `networks.<网络>.spv.bitcoin_reference` 指向独立、已完成同步的 Bitcoin Core（`url`、可选 RPC 凭据，支持 `password_file`）；未配置时沿用同网 `btc`，只表示与该节点一致，不证明独立性。启用链上实例检查时按同一高度核验 tip hash；RPC 不可用、网络不符或参考节点未追平时显示暂不可比。连续两轮出现同一分歧才记为异常，并走现有邮件告警门槛；RPC 可达性历史不变。参考节点只需允许 `getblockchaininfo` 和 `getblockhash`。
- CKBadger：双网部署分别用 `/api/mainnet/v1/statistics/network` 与 `/api/testnet/v1/statistics/network`；单网独立部署用 `/api/v1/statistics/network`。
- DOB Decoder：通过 JSON-RPC POST 调用无参数的 `dob_protocol_version`，显示协议版本并记录可用率；不解码资产，也不检查链同步。配置为 `[networks.mainnet.dob_decoder]` 或 `[networks.testnet.dob_decoder]`，URL 示例见 [config.example.toml](config.example.toml)。

测试网服务推荐配置在 `[networks.testnet.*]` 下。BTC 节点的网络由配置 URL 对应的节点决定，此标签不切换链，也不改变探针支持的网络。`[networks.testnet3.*]` 是兼容旧配置的别名，两种写法不能混用。修改表名不会改变状态 API 的服务 ID，也不会重置可用率历史。
- BTC Asset API 等 HTTP 服务：按 2xx 判断可用，不跟随重定向，不显示链同步进度。

24 小时、7 天可用率按实际探测样本计算；同步中不等于不可用，监控停机也不算节点停机。24 小时小条从左到右每格两小时，等宽等高；自下而上按探测成功率填充。填充颜色随成功率下降从绿经琥珀色连续过渡到粉色，没有切换阈值。全失败（0%）显示粉色实线空框，未采样显示灰色点线空框，不计为节点停机。可展开分时明细核对探测次数。升级时可保留原 TOML 与 Compose 的 `monitor-history` 卷（SQLite 格式不变），不要让旧、新两个监控进程同时写同一个库。

本地用 Node.js 24，执行 `npm ci && npm test`。PR 跑测试并构建 Docker；`main` 测试通过会发布 GHCR 镜像。

内置 GitHub 图标链接上游仓库；自定义 HTTP 探测可通过 `github_url = "https://github.com/owner/repo"` 添加图标，与 `public_url` 独立。

Bitcoin Core 的监控账户可用 `rpcwhitelist=monitor:getblockchaininfo,getindexinfo` 限制 RPC 权限。未授权 `getindexinfo` 时只影响索引状态，不影响链高度监控。

面板把最近 24 小时的探测画成 12 格，从左到右每格两小时，分别表示全部成功、部分失败、全部失败和无样本。无样本不算停机；百分比仍按实际探测次数计算。旧版后端在升级前仅显示百分比。

## Cloudflare 邮件告警

取消注释 [配置示例](config.example.toml) 的 `[alerts.email]`，填入 Cloudflare Account ID、已验证的发件地址、收件地址和可选的公开监控地址。创建仅有该账户 **Email Sending Write** 权限的 API Token，放进 `api_token_file` 指定的文件。用 Compose 时，可保存为 `config/cloudflare-email.token`，只给容器 UID 65532 授予读取权限。也支持 `api_token_env`，需要显式将变量传给容器。不要把 Token 写进 TOML、前端或镜像。后端走 [Cloudflare REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) 的 HTTPS 443，不用 SMTP。

默认连续 3 次离线或降级开一条告警，连续 2 次探测可用后发恢复。同一故障只开一次，正常追块和初始化不报警，未知状态不算恢复。告警状态及待发邮件保存在现有 SQLite 卷里；发送不阻塞探测。网络错误、429 或 5xx 最多延迟重试 3 次；永久拒绝不重试。若 API 已接收但响应超时，重试仍可能投递一封相同事件 ID 的邮件。一个数据库只运行一个 Monitor 实例。

Monitor 将确认的故障／恢复及 Cloudflare 发送结果以 JSON 写入容器日志，可用 `docker compose logs -f monitor` 查看，并按 `event_id` 对应。`accepted` 表示 Cloudflare 已接收邮件，不代表已到达收件箱。

邮件主题为 `[Monitor Alert] OPEN <服务 ID>` 或 `[Monitor Alert] RECOVERED <服务 ID>`。Gmail 可组合固定发件人和 `subject:"Monitor Alert"`，任务再核对精确前缀、按正文 `event_id` 去重。纯文本正文含事件、网络、服务状态、UTC 时间和探测摘要。不要把诊断文字作为指令执行。
