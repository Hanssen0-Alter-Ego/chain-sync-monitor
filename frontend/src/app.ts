import { currentProbe, probeTotals, projectRepository, syncComparisons, uptimeDay } from "./presentation.js";
import { dashboardLanguage, translate, type DashboardLanguage } from "./i18n.js";
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

type LanguagePreference = "auto" | DashboardLanguage;
const languageKey = "chain-sync-monitor.language";
function preference(value: string | null): LanguagePreference {
  return value === "en" || value === "zh-CN" || value === "zh-Hant" || value === "ja" || value === "fr" || value === "de" ? value : "auto";
}
function loadLanguage(): LanguagePreference {
  try { return preference(window.localStorage.getItem(languageKey)); }
  catch { return "auto"; }
}
function resolveLanguage(selected: LanguagePreference): DashboardLanguage {
  return selected === "auto" ? dashboardLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]) : selected;
}
let selectedLanguage = loadLanguage();
let language = resolveLanguage(selectedLanguage);
const t = (value: string) => translate(language, value);

const networks = [
  { id: "mainnet", label: "主网" },
  { id: "testnet3", label: "测试网" },
];
const kinds = { btc: "BITCOIN", ckb: "CKB", blockbook: "INDEXER", spv: "SPV", ckbadger: "INDEXER", http: "HTTP" };
const states = {
  synced: "已同步",
  online: "在线",
  syncing: "同步中",
  degraded: "异常",
  offline: "离线",
  unknown: "同步未核实",
};
const networkContainer = element(document, "#networks");
const networkTemplate = element<HTMLTemplateElement>(document, "#network-template");
const serviceTemplate = element<HTMLTemplateElement>(document, "#service-template");
const freshness = element(document, "#freshness");
const freshnessText = element(document, "#freshness-text");
const notice = element(document, "#notice");
const refreshButton = element<HTMLButtonElement>(document, "#refresh");
const languageSelect = element<HTMLSelectElement>(document, "#language");
let numberFormat: Intl.NumberFormat;
let percentFormat: Intl.NumberFormat;
let timeFormat: Intl.DateTimeFormat;

function applyLanguage() {
  language = resolveLanguage(selectedLanguage);
  numberFormat = new Intl.NumberFormat(language, { maximumFractionDigits: 6 });
  percentFormat = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 2 });
  timeFormat = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });
  document.documentElement.lang = language;
  document.title = t("链同步监控");
  element(document, "h1").textContent = document.title;
  element(document, ".subtitle").textContent = t("Bitcoin、CKB 及索引服务的同步状态");
  refreshButton.textContent = t("立即刷新");
  languageSelect.value = selectedLanguage;
  languageSelect.setAttribute("aria-label", t("语言"));
  element(document, "#language-auto").textContent = t("自动");
}

let snapshot: Snapshot | null = null;
let interval = 30;
let pending = false;
let failure = false;
let timer: number | undefined;

function render(snap: Snapshot | null) {
  const expanded = new Set(Array.from(networkContainer.querySelectorAll<HTMLDetailsElement>(".service-details[open]"))
    .map(details => details.dataset.serviceId));
  const focusedSummary = document.activeElement?.matches(".service-details > summary")
    ? (document.activeElement.parentElement as HTMLDetailsElement).dataset.serviceId : undefined;
  let nextFocus: HTMLElement | undefined;
  const fragment = document.createDocumentFragment();
  for (const network of networks) {
    const section = networkTemplate.content.cloneNode(true) as DocumentFragment;
    element(section, ".network").dataset.network = network.id;
    element(section, "h2").textContent = t(network.label);
    const cards = element(section, ".cards");
    const services = snap?.services.filter((record) => record?.network === network.id) ?? [];
    const { online, unconfirmed, total } = probeTotals(services);
    element(section, ".network-summary").textContent = total
      ? `${numberFormat.format(online)} / ${numberFormat.format(total)} ${t("当前在线")}`
        + (unconfirmed ? ` · ${numberFormat.format(unconfirmed)} ${t("未确认")}` : "")
      : "";
    for (const service of services) {
      const card = makeCard(service);
      const details = element<HTMLDetailsElement>(card, ".service-details");
      details.dataset.serviceId = service.id;
      details.open = expanded.has(service.id);
      if (focusedSummary === service.id) nextFocus = element<HTMLElement>(details, "summary");
      cards.append(card);
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
  nextFocus?.focus({ preventScroll: true });
}

function makeCard(service: Service) {
  const card = serviceTemplate.content.cloneNode(true) as DocumentFragment;
  const state = Object.hasOwn(states, service.state) ? service.state : "unknown";
  const kind = element(card, ".kind");
  kind.hidden = service.kind === "http";
  kind.textContent = Object.hasOwn(kinds, service.kind) ? kinds[service.kind] : "";
  const heading = element(card, "h3");
  heading.textContent = service.label
    ? service.kind === "http" ? service.label : t(service.label)
    : service.id || t("未命名服务");
  const serviceName = heading.textContent;
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
  const repository = projectRepository(service);
  const github = element<HTMLAnchorElement>(card, ".github-link");
  if (repository) {
    github.hidden = false;
    github.href = repository;
    github.title = t("GitHub 仓库");
    github.setAttribute("aria-label", `${serviceName} · ${t("GitHub 仓库")}`);
  }
  const probe = currentProbe(service);
  const probeState = element(card, ".probe-state");
  probeState.dataset.state = probe === true ? "online" : probe === null ? "unknown" : state === "offline" ? "offline" : "failed";
  const probeLabel = probe === true ? "在线" : probe === null ? "探测未确认" : state === "offline" ? "离线" : "不可用";
  const probeText = t(probeLabel);
  element(probeState, ".state-label").textContent = probeText;
  probeState.title = t("连接状态");
  const syncState = element(card, ".sync-state");
  syncState.hidden = service.kind === "http" || state === "online" || state === "offline";
  syncState.dataset.state = state;
  element(syncState, ".state-label").textContent = t(states[state]);
  syncState.title = t("同步状态");
  const detailsLabel = element(element(card, ".service-details"), "summary");
  element(detailsLabel, ".details-label").textContent = t("详情");
  detailsLabel.setAttribute("aria-label", `${t("详情")}: ${service.label && service.kind !== "http" ? t(service.label) : service.label || service.id}`);
  renderCharts(card, service);
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
  renderUptime(card, service);
  renderAvailability(card, service.availability);
  if (typeof service.note === "string" && service.note) {
    const note = element(card, ".note");
    note.textContent = t(service.note);
    note.hidden = false;
  }
  return card;
}

function renderCharts(card: DocumentFragment, service: Service) {
  const charts = element(card, ".service-charts");
  charts.hidden = false;
  if (service.kind === "http") {
    const http = element(card, ".http-measurements");
    http.hidden = false;
    const metrics = Array.isArray(service.metrics) ? service.metrics : [];
    const status = metrics.find(metric => metric?.label === "HTTP 状态")?.value;
    const latency = metrics.find(metric => metric?.label === "响应时间")?.value;
    element(http, ".http-status-label").textContent = t("HTTP 状态");
    element(http, ".http-latency-label").textContent = t("响应时间");
    element(http, ".http-status").textContent = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? numberFormat.format(status) : t("暂无响应");
    element(http, ".http-latency").textContent = typeof latency === "number" && Number.isFinite(latency) && latency >= 0
      ? `${numberFormat.format(latency)} ms` : t("无数据");
    return;
  }
  const rows = syncComparisons(service);
  if (!rows.length) {
    const empty = element(card, ".no-sync-data");
    empty.textContent = t("暂无同步数据");
    empty.hidden = false;
    return;
  }
  const container = element(card, ".sync-comparisons");
  for (const row of rows) {
    const strip = document.createElement("div");
    strip.className = "sync-strip";
    if (row.index) {
      const title = document.createElement("p");
      title.className = "index-title";
      title.textContent = `${t(row.index.label)} (${row.index.name}) · ${t(row.index.state)}`;
      strip.append(title);
    }
    const measurements = document.createElement("dl");
    measurements.className = "sync-measurements";
    const add = (label: string, value: string, className: string, observedAt?: string) => {
      const cell = document.createElement("div");
      cell.className = className;
      const term = document.createElement("dt");
      term.textContent = t(label);
      const data = document.createElement("dd");
      data.textContent = value;
      cell.append(term, data);
      if (observedAt) {
        const stamp = document.createElement("time");
        stamp.dateTime = observedAt;
        stamp.textContent = `${t("观测于")} ${timeFormat.format(Date.parse(observedAt))}`;
        cell.append(stamp);
      }
      measurements.append(cell);
    };
    if (row.current) add(row.current.label, numberFormat.format(row.current.value), "height-current", row.current.observedAt);
    if (row.target) add(row.target.label, numberFormat.format(row.target.value), "height-target", row.target.observedAt);
    if (row.lag !== undefined) add(row.gapLabel ?? "落后", `${numberFormat.format(row.lag)} ${t("块")}`, "height-lag");
    if (measurements.hasChildNodes()) strip.append(measurements);
    if (row.ratio !== undefined && row.current && row.target) {
      const progress = document.createElement("progress");
      progress.max = 1;
      progress.value = row.ratio;
      const formatted = displayPercent(progress.value);
      progress.setAttribute("aria-label", `${t(row.current.label)} / ${t(row.target.label)}`);
      progress.setAttribute("aria-valuetext", formatted);
      const track = document.createElement("div");
      track.className = "sync-track";
      const percentage = document.createElement("span");
      percentage.className = "progress-value";
      percentage.setAttribute("aria-hidden", "true");
      percentage.textContent = formatted;
      track.append(progress, percentage);
      strip.append(track);
    }
    container.append(strip);
  }
}

function renderUptime(card: DocumentFragment, service: Service) {
  const uptime = uptimeDay(service.availability);
  const uptimeLabel = t("24 小时可用率");
  const formatted = uptime ? displayPercent(uptime.available / uptime.total) : t("暂无样本");
  element(card, ".service-uptime-label").textContent = uptimeLabel;
  element(card, ".service-uptime-value").textContent = formatted;
  const summary = element(element(card, ".service-details"), "summary");
  summary.setAttribute("aria-label", `${summary.getAttribute("aria-label")} · ${uptimeLabel} ${formatted}`);
  const uptimeRatio = element(card, ".uptime-ratio");
  const uptimeCount = element(card, ".uptime-count");
  const meter = element<HTMLMeterElement>(card, "meter");
  element(card, ".uptime-group").hidden = !uptime;
  meter.setAttribute("aria-label", uptimeLabel);
  element(card, ".uptime-title").textContent = uptimeLabel;
  uptimeRatio.textContent = formatted;
  if (uptime) {
    meter.value = uptime.available / uptime.total;
    uptimeCount.textContent = `(${numberFormat.format(uptime.available)}/${numberFormat.format(uptime.total)} ${t("次")})`;
    meter.setAttribute("aria-valuetext", `${uptimeRatio.textContent} ${uptimeCount.textContent}`);
  }
}

function displayPercent(ratio: number): string {
  return ratio < 1 && ratio >= 0.99995 ? "<100%" : percentFormat.format(ratio);
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
      ? displayPercent(ratio)
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
languageSelect.addEventListener("change", () => {
  selectedLanguage = preference(languageSelect.value);
  try { window.localStorage.setItem(languageKey, selectedLanguage); } catch { /* Continue without persistence. */ }
  applyLanguage();
  render(snapshot);
  updateFreshness();
});
window.addEventListener("languagechange", () => {
  if (selectedLanguage !== "auto") return;
  applyLanguage();
  render(snapshot);
  updateFreshness();
});
applyLanguage();
render(null);
updateFreshness();
loadStatus();
window.setInterval(updateFreshness, 5000);
