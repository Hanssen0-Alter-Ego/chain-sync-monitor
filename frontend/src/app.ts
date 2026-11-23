import { dashboardLanguage, translate } from "./i18n.js";
import type { Availability, Service, Snapshot } from "../../shared/status.js";

declare global {
  interface Window { CHAIN_SYNC_MONITOR_API_URL?: string }
}
const statusUrl = window.CHAIN_SYNC_MONITOR_API_URL || "/api/status";

function element<T extends Element = HTMLElement>(parent: ParentNode, selector: string): T {
  const match = parent.querySelector<T>(selector);
  if (!match) throw new Error("Missing dashboard element: " + selector);
  return match;
}

const language = dashboardLanguage(navigator.languages.length ? navigator.languages : [navigator.language]);
const t = (value: string) => translate(language, value);

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
const networkContainer = element(document, "#networks");
const networkTemplate = element<HTMLTemplateElement>(document, "#network-template");
const serviceTemplate = element<HTMLTemplateElement>(document, "#service-template");
const freshness = element(document, "#freshness");
const freshnessText = element(document, "#freshness-text");
const notice = element(document, "#notice");
const refreshButton = element<HTMLButtonElement>(document, "#refresh");
const numberFormat = new Intl.NumberFormat(language, { maximumFractionDigits: 6 });
const percentFormat = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 2 });
const timeFormat = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });

document.documentElement.lang = language;
document.title = t("链同步监控");
element(document, "h1").textContent = document.title;
element(document, ".subtitle").textContent = t("Bitcoin、CKB 及索引服务的同步状态");
refreshButton.textContent = t("立即刷新");
freshnessText.textContent = t("等待数据");

let snapshot: Snapshot | null = null;
let interval = 30;
let pending = false;
let failure = false;
let timer: number | undefined;

function render(snap: Snapshot | null) {
  const fragment = document.createDocumentFragment();
  for (const network of networks) {
    const section = networkTemplate.content.cloneNode(true) as DocumentFragment;
    element(section, ".network").dataset.network = network.id;
    element(section, ".network-code").textContent = network.id.toUpperCase();
    element(section, "h2").textContent = t(network.label);
    const cards = element(section, ".cards");
    const services = snap?.services.filter((record) => record?.network === network.id) ?? [];
    element(section, ".network-summary").textContent = services.length
      ? `${services.filter(({ state }) => state === "synced" || state === "online").length} / ${services.length} ${t("正常")}`
      : "";
    for (const service of services) {
      cards.append(makeCard(service));
    }
    if (!services.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = t(!snap ? "等待状态数据…" : "暂无服务数据");
      cards.append(empty);
    }
    fragment.append(section);
  }
  networkContainer.replaceChildren(fragment);
}

function makeCard(service: Service) {
  const card = serviceTemplate.content.cloneNode(true) as DocumentFragment;
  const state = Object.hasOwn(states, service.state) ? service.state : "unknown";
  element(card, ".kind").textContent = Object.hasOwn(kinds, service.kind)
    ? kinds[service.kind] : "SERVICE";
  const heading = element(card, "h3");
  heading.textContent = service.label
    ? service.kind === "http" ? service.label : t(service.label)
    : service.id || t("未命名服务");
  if (typeof service.publicUrl === "string") {
    try {
      const target = new URL(service.publicUrl);
      if (["https:", "http:"].includes(target.protocol) && !target.username && !target.password) {
        const link = document.createElement("a");
        link.textContent = heading.textContent;
        link.href = target.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        heading.replaceChildren(link);
      }
    } catch { /* invalid links are not rendered */ }
  }
  element(card, ".state").dataset.state = state;
  element(card, ".state-label").textContent = t(states[state]);
  if (typeof service.progress === "number" && Number.isFinite(service.progress)
      && service.progress >= 0 && service.progress <= 1) {
    element(card, ".progress-group").hidden = false;
    const progress = element<HTMLProgressElement>(card, "progress");
    progress.value = service.progress;
    progress.setAttribute("aria-label", t("同步进度"));
    element(card, ".progress-title").textContent = t("同步进度");
    element(card, ".progress-value").textContent =
      service.progress < 1 && service.progress >= 0.99995 ? "<100%" : percentFormat.format(service.progress);
  }
  const metrics = element(card, ".metrics");
  for (const metric of Array.isArray(service.metrics) ? service.metrics : []) {
    if (!metric || typeof metric.label !== "string") continue;
    const row = document.createElement("div");
    const key = document.createElement("dt");
    const value = document.createElement("dd");
    key.textContent = t(metric.label);
    const raw = metric.value;
    value.textContent = typeof raw === "number"
      ? numberFormat.format(raw)
      : typeof raw === "string" && raw ? t(raw) : t("不明");
    if (typeof metric.unit === "string" && metric.unit) {
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = " " + t(metric.unit);
      value.append(unit);
    }
    row.append(key, value);
    metrics.append(row);
  }
  renderAvailability(card, service.availability);
  if (typeof service.note === "string" && service.note) {
    const note = element(card, ".note");
    note.textContent = t(service.note);
    note.hidden = false;
  }
  return card;
}

function renderAvailability(card: DocumentFragment, availability: Availability) {
  if (!Array.isArray(availability?.windows)) return;
  const area = element(card, ".availability");
  const title = element(area, ".availability-title");
  title.textContent = t("探测可用率");
  title.title = t("按探测样本计算，与链同步进度无关");
  const list = element(area, ".availability-windows");
  for (const [seconds, label] of [[86400, "24 小时"], [604800, "7 天"]] as const) {
    const sample = availability.windows.find((item) => item?.seconds === seconds);
    if (!sample) continue;
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = t(label);
    const ratio = sample.ratio;
    const hasRatio = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
    value.textContent = hasRatio
      ? ratio < 1 && ratio >= 0.99995 ? "<100%" : percentFormat.format(ratio)
      : t("暂无样本");
    if (Number.isInteger(sample.available) && Number.isInteger(sample.total) && sample.total > 0) {
      const count = document.createElement("span");
      count.className = "sample-count";
      count.textContent = `${numberFormat.format(sample.available)}/${numberFormat.format(sample.total)} ${t("次")}`;
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
    ? `${failure || stale ? t("数据可能已过期") + " · " : ""}${t("更新于")} ${timeFormat.format(time)}`
    : t(failure ? "无法获取状态" : "等待首次采集");
  if (freshness.dataset.status !== nextStatus) freshness.dataset.status = nextStatus;
  if (freshnessText.textContent !== nextText) freshnessText.textContent = nextText;
  const historyError = typeof snapshot?.historyError === "string" ? t(snapshot.historyError) : "";
  notice.hidden = !failure && !historyError;
  if (failure) {
    const alert = t(snapshot ? "刷新失败，保留上次收到的状态。" : "暂时无法读取状态，页面会自动重试。");
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
    const response = await fetch(statusUrl, { cache: "no-store", signal: controller.signal, credentials: "same-origin" });
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
