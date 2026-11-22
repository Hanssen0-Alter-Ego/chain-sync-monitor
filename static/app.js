"use strict";

const networks = [
  { id: "mainnet", label: "主网" },
  { id: "testnet3", label: "测试网（Bitcoin Testnet3）" },
];
const kinds = { btc: "BITCOIN", ckb: "CKB", blockbook: "INDEXER", spv: "SPV", ckbadger: "INDEXER", http: "HTTP" };
const states = {
  synced: "已同步",
  online: "在线",
  syncing: "同步中",
  degraded: "异常",
  offline: "离线",
  unknown: "未知",
};
const networkContainer = document.querySelector("#networks");
const networkTemplate = document.querySelector("#network-template");
const serviceTemplate = document.querySelector("#service-template");
const freshness = document.querySelector("#freshness");
const freshnessText = document.querySelector("#freshness-text");
const notice = document.querySelector("#notice");
const refreshButton = document.querySelector("#refresh");
const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });
const percentFormat = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" });

let snapshot = null;
let interval = 30;
let pending = false;
let failure = false;
let timer;

function render(snap) {
  const fragment = document.createDocumentFragment();
  for (const network of networks) {
    const section = networkTemplate.content.cloneNode(true);
    section.querySelector(".network").dataset.network = network.id;
    section.querySelector(".network-code").textContent = network.id.toUpperCase();
    section.querySelector("h2").textContent = network.label;
    const cards = section.querySelector(".cards");
    const services = snap?.services.filter((record) => record?.network === network.id) ?? [];
    section.querySelector(".network-summary").textContent = services.length
      ? `${services.filter(({ state }) => state === "synced" || state === "online").length} / ${services.length} 正常`
      : "";
    for (const service of services) {
      cards.append(makeCard(service));
    }
    if (!services.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = !snap ? "等待状态数据…" : "暂无服务数据";
      cards.append(empty);
    }
    fragment.append(section);
  }
  networkContainer.replaceChildren(fragment);
}

function makeCard(service) {
  const card = serviceTemplate.content.cloneNode(true);
  const state = Object.hasOwn(states, service.state) ? service.state : "unknown";
  card.querySelector(".kind").textContent = Object.hasOwn(kinds, service.kind)
    ? kinds[service.kind] : "SERVICE";
  card.querySelector("h3").textContent = service.label || service.id || "未命名服务";
  card.querySelector(".state").dataset.state = state;
  card.querySelector(".state-label").textContent = states[state];
  if (typeof service.progress === "number" && Number.isFinite(service.progress)
      && service.progress >= 0 && service.progress <= 1) {
    card.querySelector(".progress-group").hidden = false;
    card.querySelector("progress").value = service.progress;
    card.querySelector(".progress-value").textContent =
      service.progress < 1 && service.progress >= 0.99995 ? "<100%" : percentFormat.format(service.progress);
  }
  const metrics = card.querySelector(".metrics");
  for (const metric of Array.isArray(service.metrics) ? service.metrics : []) {
    if (!metric || typeof metric.label !== "string") continue;
    const row = document.createElement("div");
    const key = document.createElement("dt");
    const value = document.createElement("dd");
    key.textContent = metric.label;
    const raw = metric.value;
    value.textContent = typeof raw === "number"
      ? numberFormat.format(raw)
      : typeof raw === "string" && raw ? raw : "不明";
    if (typeof metric.unit === "string" && metric.unit) {
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = " " + metric.unit;
      value.append(unit);
    }
    row.append(key, value);
    metrics.append(row);
  }
  renderAvailability(card, service.availability);
  if (typeof service.note === "string" && service.note) {
    const note = card.querySelector(".note");
    note.textContent = service.note;
    note.hidden = false;
  }
  return card;
}

function renderAvailability(card, availability) {
  if (!Array.isArray(availability?.windows)) return;
  const area = card.querySelector(".availability");
  const list = area.querySelector(".availability-windows");
  for (const [seconds, label] of [[86400, "24 小时"], [604800, "7 天"]]) {
    const sample = availability.windows.find((item) => item?.seconds === seconds);
    if (!sample) continue;
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = label;
    const ratio = sample.ratio;
    const hasRatio = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
    value.textContent = hasRatio
      ? ratio < 1 && ratio >= 0.99995 ? "<100%" : percentFormat.format(ratio)
      : "暂无样本";
    if (Number.isInteger(sample.available) && Number.isInteger(sample.total) && sample.total > 0) {
      const count = document.createElement("span");
      count.className = "sample-count";
      count.textContent = `${numberFormat.format(sample.available)}/${numberFormat.format(sample.total)} 次`;
      value.append(" ", count);
    }
    row.append(term, value);
    list.append(row);
  }
  area.hidden = !list.hasChildNodes();
}

function updateFreshness() {
  const time = typeof snapshot?.updatedAt === "string" ? Date.parse(snapshot.updatedAt) : NaN;
  const known = Number.isFinite(time);
  const stale = known && Date.now() - time > Math.max(30, interval * 3) * 1000;
  const nextStatus = failure || stale ? "stale" : known ? "fresh" : "unknown";
  const nextText = known
    ? `${failure || stale ? "数据可能已过期 · " : ""}更新于 ${timeFormat.format(time)}`
    : failure ? "无法获取状态" : "等待首次采集";
  if (freshness.dataset.status !== nextStatus) freshness.dataset.status = nextStatus;
  if (freshnessText.textContent !== nextText) freshnessText.textContent = nextText;
  const historyError = typeof snapshot?.historyError === "string" ? snapshot.historyError : "";
  notice.hidden = !failure && !historyError;
  if (failure) {
    const alert = snapshot ? "刷新失败，保留上次收到的状态。" : "暂时无法读取状态，页面会自动重试。";
    if (notice.textContent !== alert) notice.textContent = alert;
  } else if (historyError && notice.textContent !== historyError) {
    notice.textContent = historyError;
  }
}

async function loadStatus() {
  if (pending) return;
  window.clearTimeout(timer);
  pending = true;
  refreshButton.disabled = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("/api/status", { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Status request failed");
    const data = await response.json();
    if (!data || !Array.isArray(data.services)) throw new Error("Invalid status");
    if (Number.isFinite(data.intervalSeconds) && data.intervalSeconds > 0) {
      interval = Math.max(2, Math.min(3600, data.intervalSeconds));
    }
    snapshot = data;
    failure = false;
    render(snapshot);
  } catch {
    failure = true;
  } finally {
    window.clearTimeout(timeout);
    pending = false;
    refreshButton.disabled = false;
    updateFreshness();
    timer = window.setTimeout(loadStatus, interval * 1000);
  }
}

refreshButton.addEventListener("click", loadStatus);
render(null);
loadStatus();
window.setInterval(updateFreshness, 5000);
