export type DashboardLanguage = "en" | "zh-CN";

export function dashboardLanguage(preferences: readonly string[]): DashboardLanguage {
  for (const preference of preferences) {
    const language = preference.toLowerCase().split("-")[0];
    if (language === "zh") return "zh-CN";
    if (language === "en") return "en";
  }
  return "en";
}

// Keep status payloads compatible with previously deployed monitor backends.
// Unknown/custom labels are preserved verbatim.
const en = new Map(Object.entries({
  "链同步监控": "Chain Sync Monitor",
  "Bitcoin、CKB 及索引服务的同步状态": "Sync status for Bitcoin, CKB, and indexing services",
  "立即刷新": "Refresh now",
  "主网": "Mainnet",
  "测试网（Bitcoin Testnet3）": "Testnet (Bitcoin Testnet3)",
  "已同步": "Synced",
  "在线": "Online",
  "同步中": "Syncing",
  "异常": "Degraded",
  "离线": "Offline",
  "未知": "Unknown",
  "正常": "healthy",
  "是": "Yes",
  "否": "No",
  "块": "blocks",
  "分钟": "min",
  "次": "checks",
  "24 小时": "24 hours",
  "7 天": "7 days",
  "不明": "Unknown",
  "等待数据": "Waiting for data",
  "等待状态数据…": "Waiting for status…",
  "暂无服务数据": "No service data",
  "未命名服务": "Unnamed service",
  "同步进度": "Sync progress",
  "探测可用率": "Probe availability",
  "按探测样本计算，与链同步进度无关": "Based on probe samples, independent of chain sync progress",
  "暂无样本": "No samples",
  "数据可能已过期": "Data may be stale",
  "更新于": "Updated",
  "无法获取状态": "Status unavailable",
  "等待首次采集": "Waiting for the first check",
  "刷新失败，保留上次收到的状态。": "Refresh failed. Showing the last received status.",
  "暂时无法读取状态，页面会自动重试。": "Could not fetch status. The page will retry automatically.",
  "无法读取或写入可用率历史，实时同步检查仍在运行。": "Could not read or write availability history. Live checks continue.",
  "CKB 节点与索引器": "CKB node and indexer",
  "Bitcoin SPV 服务": "Bitcoin SPV service",
  "已验证区块高度": "Verified block height",
  "区块头高度": "Header height",
  "落后区块头": "Behind headers",
  "最新区块时间": "Latest block time",
  "节点区块高度": "Node block height",
  "已知区块高度": "Known block height",
  "未验证区块高度": "Unverified block height",
  "下载中": "Downloading",
  "索引器高度": "Indexer height",
  "索引器落后": "Indexer lag",
  "索引高度": "Index height",
  "链同步": "Chain synced",
  "内存池同步": "Mempool synced",
  "配置的 Core 高度": "Configured Core height",
  "落后 Core": "Behind Core",
  "CKB 目标高度": "CKB target height",
  "落后": "Lag",
  "索引模式": "Indexing mode",
  "链上 SPV 高度": "On-chain SPV height",
  "起始 BTC 高度": "Starting BTC height",
  "SPV 客户端数": "SPV client count",
  "本地 BTC 高度": "Local BTC height",
  "SPV 落后": "SPV lag",
  "HTTP 状态": "HTTP status",
  "响应时间": "Response time",
  "证明 RPC": "Proof RPC",
  "REST 高度未更新": "REST height unchanged for",
  "等待首次检查。": "Waiting for the first check.",
  "Bitcoin Core 正在启动或加载数据。": "Bitcoin Core is starting or loading data.",
  "Bitcoin Core 未返回有效链信息。": "Bitcoin Core did not return valid chain information.",
  "Bitcoin Core 返回的网络与配置不符。": "Bitcoin Core reported a different network than configured.",
  "Bitcoin Core 未返回有效的区块高度、头高度或 IBD 状态。": "Bitcoin Core did not return valid block height, header height, or IBD status.",
  "按本节点所见的区块头判断，不代表已核对外部网络高度。": "Based on headers known to this node, not an independently verified network height.",
  "同步状态格式不匹配。": "Unexpected sync status format.",
  "索引器高度格式不匹配。": "Unexpected indexer height format.",
  "检查失败。": "Check failed.",
  "节点和索引器在同一高度报告了不同区块。": "The node and indexer reported different blocks at the same height.",
  "索引器还没有返回区块高度。": "The indexer has not reported a block height yet.",
  "Blockbook 未返回有效状态。": "Blockbook did not return valid status.",
  "Blockbook 后端返回的 Bitcoin 网络与配置不符。": "The Blockbook backend reported a different Bitcoin network than configured.",
  "Blockbook 报告 Bitcoin 后端异常。": "Blockbook reported a Bitcoin backend error.",
  "Blockbook REST 尚未报告足够的同步状态。": "Blockbook REST has not reported enough sync data yet.",
  "Blockbook 所连节点与配置的 Core 同高度区块哈希不同。": "Blockbook and the configured Core node reported different block hashes at the same height.",
  "以 Blockbook REST 报告为准；全量索引时高度可能不会持续刷新。": "Based on Blockbook REST. The height may not update continuously during bulk indexing.",
  "Blockbook 自报已同步，尚无同步的 Bitcoin Core 高度可核对。": "Blockbook reports being synced, but there is no synced Bitcoin Core height to compare.",
  "Blockbook 索引高度高于配置的 Core，请核对两者的后端。": "Blockbook is ahead of the configured Core node. Check which backend each service uses.",
  "同步标记正常，索引高度与配置的 Core 一致。": "Sync flags are healthy and the index height matches the configured Core node.",
  "CKBadger 未返回有效的网络同步状态。": "CKBadger did not return valid network sync status.",
  "CKBadger 报告深度分叉。": "CKBadger reported a deep fork.",
  "目标高度低于索引高度，暂时无法比较。": "The target height is below the index height and cannot be compared yet.",
  "RPC 在线；配置 type_script 可查看链上 SPV 高度。": "RPC is online. Configure type_script to see the on-chain SPV height.",
  "RPC 在线；请配置 CKB 端点以核对链上 SPV 高度。": "RPC is online. Configure a CKB endpoint to check the on-chain SPV height.",
  "SPV type_script 无效（要求 32 字节 code hash 和 34 字节 args）。": "Invalid SPV type_script (requires a 32-byte code hash and 34-byte args).",
  "链上 SPV 查询未返回有效结果。": "The on-chain SPV query returned no valid result.",
  "链上 SPV Cell 格式无效。": "Invalid on-chain SPV cell format.",
  "出现未知或重复的 SPV Cell。": "Unknown or duplicate SPV cell.",
  "SPV 实例在 CKB 索引器中尚未完整可见。": "The SPV instance is not yet fully visible in the CKB indexer.",
  "SPV RPC 未提供本地缓存高度。": "The SPV RPC does not report its local cache height.",
  "SPV RPC 未提供本地缓存高度。 暂无可比对的 BTC 高度。": "The SPV RPC does not report its local cache height. No BTC height is available for comparison.",
  "RPC 在线；链上检查未成功。": "RPC is online, but the on-chain check failed.",
  "CKBadger 正在初始化索引。": "CKBadger is initializing its index.",
  "CKBadger 返回 HTTP 503。": "CKBadger returned HTTP 503.",
  "HTTP 探测要求 2xx，不跟随重定向。": "The HTTP probe requires a 2xx response and does not follow redirects.",
  "仅验证 RPC 可达，不能据此判断链上同步。": "Only RPC reachability was verified, not on-chain sync.",
  "端点未公开 getTxProof。": "The endpoint does not expose getTxProof.",
  "端点未按预期拒绝空参数；同步仍未经验证。": "The endpoint did not reject empty parameters as expected. Sync remains unverified.",
  "检查失败，未能取得有效数据。": "The check did not return valid data.",
  "上游返回重定向，未跟随。": "The upstream service returned a redirect, which was not followed.",
  "上游响应超过大小限制。": "The upstream response exceeded the size limit.",
  "无法读取 HTTP 响应。": "Could not read the HTTP response.",
  "无法连接上游或读取 HTTP 响应。": "Could not connect to the upstream service or read its HTTP response.",
  "上游请求超时。": "The upstream request timed out.",
  "上游没有返回有效的 JSON。": "The upstream service did not return valid JSON.",
  "上游返回的 RPC 响应格式不匹配。": "The upstream RPC returned an unexpected response format.",
}));

export function translate(language: DashboardLanguage, value: string): string {
  if (language !== "en") return value;
  const direct = en.get(value);
  if (direct !== undefined) return direct;
  const rpc = /^RPC 返回错误（(-?\d+)）。$/.exec(value);
  if (rpc) return `RPC returned error ${rpc[1]}.`;
  const http = /^上游返回 HTTP (\d+)。$/.exec(value);
  if (http) return `The upstream service returned HTTP ${http[1]}.`;
  const checks = value.split(/ (?=(?:sync_state|get_indexer_tip)：)/);
  if (checks.length > 1) return checks.map((note) => translate(language, note)).join(" ");
  const prefix = /^(sync_state|get_indexer_tip)：(.+)$/.exec(value);
  if (prefix) return `${prefix[1]}: ${translate(language, prefix[2])}`;
  const onChain = "RPC 在线；链上检查未成功。";
  if (value.startsWith(onChain)) return en.get(onChain) + " " + translate(language, value.slice(onChain.length));
  return value;
}
