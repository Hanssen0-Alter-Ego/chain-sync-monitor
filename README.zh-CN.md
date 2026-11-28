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
- SPV：支持 `getSyncStatus` 的服务会显示缓存的 BTC 高度、本地头高度和最近确认的链上客户端高度，附可用的观测时间。缓存不等于独立验证同步。可选在 SPV 条目里直接填写完整实例的 `code_hash`、`hash_type` 和 `args` 通过 CKB Indexer 核验链上高度；配置的 Bitcoin Core 高度优先。旧版证明 RPC 仍可用。 可配 SPV 条目的 `bitcoin_reference` 子表 指向独立、已完成同步的 Bitcoin Core（`url`、可选 RPC 凭据，支持 `password_file`）；未配置时沿用同网 `btc`，只表示与该节点一致，不证明独立性。启用链上实例检查时按同一高度核验 tip hash；RPC 不可用、网络不符或参考节点未追平时显示暂不可比。连续两轮出现同一分歧才记为异常，并走现有邮件告警门槛；RPC 可达性历史不变。参考节点只需允许 `getblockchaininfo` 和 `getblockhash`。
- CKBadger：双网部署分别用 `/api/mainnet/v1/statistics/network` 与 `/api/testnet/v1/statistics/network`；单网独立部署用 `/api/v1/statistics/network`。
- DOB Decoder：通过 JSON-RPC POST 调用无参数的 `dob_protocol_version`，显示协议版本并记录可用率；不解码资产，也不检查链同步。添加 `kind = "dob_decoder"` 的服务条目，URL 示例见 [config.example.toml](config.example.toml)。

### 自定义展示分组

主网／测试网显示在每张卡片「在线」左边。可以用 `[groups.<名称>]`
自由命名分组，并在 `[[groups.<名称>.services]]` 逐项设置服务；同一组可以混放主网、测试网及普通应用：

```toml
[groups.infrastructure]
label = "基础设施"

[[groups.infrastructure.services]]
kind = "ckb"
network = "mainnet"
url = "http://127.0.0.1:8114"

[[groups.infrastructure.services]]
kind = "http"
id = "portal"
label = "门户"
url = "https://portal.example.com/health"
```

链探针用 `network = "mainnet"` 或 `"testnet"`，HTTP 与 DOB Decoder 可省略
`network`，不显示网络标签。分组的 `label` 省略时用分组名本身。
历史和告警 ID 由网络、探针类型和 HTTP 的 `id` 决定，与分组无关。
网络标签不会切换 URL 对应的链。

- BTC Asset API 等 HTTP 服务：按 2xx 判断可用，不跟随重定向，不显示链同步进度。

24 小时、7 天可用率按实际探测样本计算；同步中不等于不可用，监控停机也不算节点停机。24 小时小条从左到右每格两小时，等宽等高；自下而上按探测成功率填充。填充颜色随成功率下降从绿经琥珀色连续过渡到粉色，没有切换阈值。全失败（0%）显示粉色实线空框，未采样显示灰色点线空框，不计为节点停机。可展开分时明细核对探测次数。升级时可保留 Compose 的 `monitor-history` 卷（SQLite 格式不变），不要让旧、新两个监控进程同时写同一个库。

本地用 Node.js 24，执行 `npm ci && npm test`。PR 跑测试并构建 Docker；`main` 测试通过会发布 GHCR 镜像。

内置 GitHub 图标链接上游仓库；自定义 HTTP 探测可通过 `github_url = "https://github.com/owner/repo"` 添加图标，与 `public_url` 独立。

Bitcoin Core 的监控账户可用 `rpcwhitelist=monitor:getblockchaininfo,getindexinfo` 限制 RPC 权限。未授权 `getindexinfo` 时只影响索引状态，不影响链高度监控。

面板把最近 24 小时的探测画成 12 格，从左到右每格两小时，分别表示全部成功、部分失败、全部失败和无样本。无样本不算停机；百分比仍按实际探测次数计算。旧版后端在升级前仅显示百分比。

## Cloudflare 邮件告警

取消注释 [配置示例](config.example.toml) 的 `[alerts.email]`，填入 Cloudflare Account ID、已验证的发件地址、收件地址和可选的公开监控地址。创建仅有该账户 **Email Sending Write** 权限的 API Token，放进 `api_token_file` 指定的文件。用 Compose 时，可保存为 `config/cloudflare-email.token`，只给容器 UID 65532 授予读取权限。也支持 `api_token_env`，需要显式将变量传给容器。不要把 Token 写进 TOML、前端或镜像。后端走 [Cloudflare REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) 的 HTTPS 443，不用 SMTP。

默认连续 3 次离线或降级会开启事故。对处于正常增量模式且 HTTP 可达的 CKBadger，落后同网络 CKB 节点至少 `lag_blocks` 块（默认 2），持续 `lag_seconds` 秒（默认 300），并满足 `failure_checks` 才确认索引落后。请为相同网络配置 `ckb` RPC 和 CKBadger 统计地址。Monitor 使用本轮非 IBD 节点的链尖，要求它达到已知最高块、块时间新鲜，并通过 `get_block_hash("0x0")` 校验网络创世哈希。统计返回索引块哈希时也会与节点核对。旧版独立部署如未提供哈希，CKBadger 所属网络依赖端点配置。

CKBadger 必须连续至少两次与验证链尖相差不超过 1 块才恢复，`recovery_checks` 更高时采用更高值。刚恢复 HTTP、初始化、bulk、缺失、冲突及陈旧样本都不能关闭事故。节点块时间与 HTTP 统计样本的有效期为 5 分钟。采样中断超过轮询周期的 1.5 倍和请求超时的 2 倍两者中较长的一项时，重新计数。差距超过 1 块但低于自定义告警门槛时也会中断确认。其他服务沿用原有恢复条件。CKBadger 正常返回有效统计时，每次探测都计为可用，包括确认索引落后并发送告警的那一次。

首次确认故障发 `OPEN`，恢复发 `RECOVERED`。同一事故在 `offline`、`degraded`、`reachable-but-lagging` 之间每次确认切换，会发一封 `[Monitor Alert] CHANGED <服务 ID>`。

SQLite 同一事务保存事故和待发事件。升级保留活动事故 ID、首次故障时间和待发邮件，旧版未确认的计数重新开始。仍保留的原 OPEN 可还原上次确认状态。如果 OPEN 已过保留期，下一次确认的离线或降级静默建立基线。此时首次确认索引落后或恢复可带 `previous_state: unknown`。一个数据库运行一个 Monitor 实例。网络错误、429 和 5xx 最多延迟重试 3 次。若服务商接收后响应超时或进程退出，可能重投相同事件 ID。使用 `docker compose logs -f monitor` 按 `event_id` 对应事故和投递日志。`accepted` 表示 Cloudflare 已接收。

### 下游事件处理

1. Work/Gmail 触发器应匹配精确发件人和服务白名单，主题正则使用 `^\[Monitor Alert\] (OPEN|CHANGED|RECOVERED) ([a-z0-9_:-]+)$`。
2. 转发前只解析纯文本正文的结构化头部，核对 `schema: chain-sync-monitor/1`、主题与正文的事件和服务 ID、已知服务及其网络、事件 ID 与事故 ID 的对应关系。OPEN、RECOVERED 继续使用 `<incident>:open`、`<incident>:recovered`。CHANGED 使用 `<incident>:changed:<uuid>`。重复切换各有独立事件 ID，投递重试按完整 `event_id` 去重。旧队列中的邮件可能没有新增字段。
3. 用本地样例确认 Telegram、邮件、ChatGPT 模板能处理 OPEN → CHANGED → CHANGED → RECOVERED 及重复投递。CHANGED 展示为进行中的事故，列出 `previous_state`、`state`、`reason`、`state_observed_since`、`observed_at` 和可用的 `tip_lag_blocks`。离开落后状态时，`previous_tip_lag_blocks` 和 `previous_lag_observed_at` 表示上次测到的差距和时间。探测摘要仅作数据处理，仅 RECOVERED 关闭事故。
