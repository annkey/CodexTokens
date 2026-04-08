const summaryHost = document.getElementById("summaryCards");
const insightGrid = document.getElementById("insightGrid");
const chartHost = document.getElementById("chartHost");
const donutHost = document.getElementById("donutHost");
const breakdownHost = document.getElementById("breakdown");
const highlightsHost = document.getElementById("highlights");
const threadTable = document.getElementById("threadTable");
const refreshButton = document.getElementById("refreshButton");
const syncButton = document.getElementById("syncButton");
const timezoneNode = document.getElementById("timezone");
const generatedAtNode = document.getElementById("generatedAt");
const codexHomeNode = document.getElementById("codexHome");
const trendTitleNode = document.getElementById("trendTitle");
const lastSyncedAtNode = document.getElementById("lastSyncedAt");
const dataSourceNode = document.getElementById("dataSource");
const syncMessageNode = document.getElementById("syncMessage");
const emptyState = document.getElementById("emptyState");

let dashboardData = null;
let currentView = "daily";

const categoryPalette = {
  input: "#4d8ef7",
  output: "#f56c8c",
  cached: "#4ed0c0",
  reasoning: "#ffcf4a",
  tool: "#dbe8fb",
};

const categoryLabels = {
  input: "输入 Tokens",
  output: "输出 Tokens",
};

const seriesTitle = {
  daily: "每日 Token 用量",
  weekly: "每周 Token 用量",
  monthly: "每月 Token 用量",
};

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(value || 0));
}

function formatCompact(value) {
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.round(value || 0));
}

function formatPercent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatDateTime(isoString, timeZone) {
  if (!isoString) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoString));
}

function formatUnixSeconds(seconds, timeZone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSummaryCards(data) {
  const cards = [
    ["today", "今日用量"],
    ["thisWeek", "本周用量"],
    ["thisMonth", "本月用量"],
    ["allTime", "累计用量"],
  ];

  summaryHost.innerHTML = cards
    .map(([key, label]) => {
      const item = data.summaryCards[key];
      return `
        <article class="summary-card">
          <p class="eyebrow">${label}</p>
          <div class="summary-value">${formatCompact(item.total)}</div>
          <h3>${formatNumber(item.total)} tokens</h3>
          <p class="summary-sub">响应次数 ${formatNumber(item.count)} 次</p>
        </article>
      `;
    })
    .join("");
}

function renderInsights(data) {
  const analytics = data.analytics;
  const insightCards = [
    { label: "日环比", value: formatPercent(analytics.dayOverDay), sub: "相较昨日总用量", trend: analytics.dayOverDay },
    { label: "周环比", value: formatPercent(analytics.weekOverWeek), sub: "相较上周总用量", trend: analytics.weekOverWeek },
    { label: "月环比", value: formatPercent(analytics.monthOverMonth), sub: "相较上月总用量", trend: analytics.monthOverMonth },
    { label: "7日平均用量", value: formatCompact(analytics.movingAverage7d), sub: "" },
  ];

  insightGrid.innerHTML = insightCards
    .map((item) => `
      <article class="insight-card">
        <div class="insight-row">
          <div>
            <p class="insight-label">${item.label}</p>
            <div class="insight-value">${item.value}</div>
          </div>
          ${typeof item.trend === "number" ? `<span class="insight-trend ${item.trend > 0 ? "up" : "down"}">${item.trend > 0 ? "上升" : "下降"}</span>` : ""}
        </div>
        ${item.sub ? `<p class="insight-sub">${item.sub}</p>` : ""}
      </article>
    `)
    .join("");
}

function renderDonut(data) {
  const categories = ["input", "output"];
  const total = categories.reduce((sum, key) => sum + (data.categoryTotals[key] || 0), 0) || 1;
  const radius = 94;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const segments = categories
    .map((key) => {
      const value = data.categoryTotals[key] || 0;
      const length = (value / total) * circumference;
      const segment = `
        <circle class="donut-segment" cx="160" cy="160" r="${radius}" stroke="${categoryPalette[key]}"
          stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 160 160)"></circle>
      `;
      offset += length;
      return segment;
    })
    .join("");

  donutHost.innerHTML = `
    <svg class="donut-svg" viewBox="0 0 320 320" role="img" aria-label="Token 占比图">
      <circle class="donut-track" cx="160" cy="160" r="${radius}"></circle>
      ${segments}
      <text class="donut-center-total" x="160" y="146">总 Tokens</text>
      <text class="donut-center-value" x="160" y="185">${formatCompact(total)}</text>
    </svg>
  `;
}

function renderBreakdown(data) {
  const categories = ["input", "output"];
  const total = categories.reduce((sum, key) => sum + (data.categoryTotals[key] || 0), 0) || 1;

  breakdownHost.innerHTML = categories
    .map((key) => {
      const value = data.categoryTotals[key] || 0;
      const percent = (value / total) * 100;
      return `
        <div class="breakdown-item">
          <div class="breakdown-row">
            <strong>${categoryLabels[key]}</strong>
            <span>${formatCompact(value)} / ${percent.toFixed(1)}%</span>
          </div>
          <div class="progress">
            <span style="width:${percent}%; background:${categoryPalette[key]}"></span>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderHighlights(data) {
  const items = [
    ["单日峰值", data.highlights.peakDay.label || "-", data.highlights.peakDay.total],
    ["单周峰值", data.highlights.peakWeek.label || "-", data.highlights.peakWeek.total],
    ["单月峰值", data.highlights.peakMonth.label || "-", data.highlights.peakMonth.total],
    ["响应总数", "去重后的 response.completed 记录", data.highlights.totalResponses],
  ];

  highlightsHost.innerHTML = items
    .map(([label, sub, value]) => `
      <div class="highlight-item">
        <p class="eyebrow">${label}</p>
        <h3>${formatCompact(value)}</h3>
        <p class="highlight-sub">${sub}</p>
      </div>
    `)
    .join("");
}

function renderThreadTable(data) {
  threadTable.innerHTML = data.topThreads
    .slice(0, 5)
    .map((thread) => `
      <tr>
        <td class="thread-cell">
          <div class="thread-title" title="${escapeHtml(thread.title)}">${escapeHtml(thread.title)}</div>
          <span class="thread-path">${escapeHtml(thread.cwd)}</span>
        </td>
        <td class="model-cell">${escapeHtml(thread.model)}</td>
        <td>${formatNumber(thread.tokensUsed)}</td>
        <td>${formatUnixSeconds(thread.updatedAt, data.timeZone)}</td>
      </tr>
    `)
    .join("");
}

function buildTrendChart(series) {
  if (!series.length || !series.some((item) => item.total > 0 || item.input > 0 || item.output > 0)) {
    chartHost.innerHTML = "";
    chartHost.append(emptyState.content.cloneNode(true));
    return;
  }

  const width = 960;
  const height = 320;
  const padding = { top: 14, right: 20, bottom: 42, left: 58 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...series.flatMap((item) => [item.total, item.input, item.output]), 1);
  const slotWidth = innerWidth / series.length;
  const barWidth = Math.min(12, slotWidth * 0.2);

  const guideValues = Array.from({ length: 5 }, (_, index) => Math.round((maxValue / 4) * (4 - index)));
  const guideMarkup = guideValues.map((value) => {
    const y = padding.top + innerHeight - (value / maxValue) * innerHeight;
    return `
      <line class="grid-line" x1="${padding.left}" y1="${y}" x2="${padding.left + innerWidth}" y2="${y}" />
      <text class="axis-label" x="${padding.left - 12}" y="${y + 4}" text-anchor="end">${formatCompact(value)}</text>
    `;
  }).join("");

  const barsMarkup = series.map((item, index) => {
    const centerX = padding.left + index * slotWidth + slotWidth / 2;
    const totalHeight = (item.total / maxValue) * innerHeight;
    const inputHeight = (item.input / maxValue) * innerHeight;
    const outputHeight = (item.output / maxValue) * innerHeight;
    const totalY = padding.top + innerHeight - totalHeight;
    const inputY = padding.top + innerHeight - inputHeight;
    const outputY = padding.top + innerHeight - outputHeight;

    return `
      <g>
        <rect class="bar-primary" x="${centerX - barWidth * 1.5 - 4}" y="${totalY}" width="${barWidth}" height="${Math.max(totalHeight, 2)}" rx="2"></rect>
        <rect class="bar-secondary" x="${centerX - barWidth / 2}" y="${inputY}" width="${barWidth}" height="${Math.max(inputHeight, 2)}" rx="2"></rect>
        <rect class="bar-tertiary" x="${centerX + barWidth / 2 + 4}" y="${outputY}" width="${barWidth}" height="${Math.max(outputHeight, 2)}" rx="2"></rect>
        <title>${item.label}: 总量 ${formatNumber(item.total)}，输入 ${formatNumber(item.input)}，输出 ${formatNumber(item.output)}</title>
      </g>
    `;
  }).join("");

  const labelStep = Math.max(1, Math.ceil(series.length / 7));
  const labelMarkup = series
    .map((item, index) => ({ ...item, x: padding.left + index * slotWidth + slotWidth / 2, index }))
    .filter((point) => point.index % labelStep === 0 || point.index === series.length - 1)
    .map((point) => `
      <text class="axis-label" x="${point.x}" y="${height - 10}" text-anchor="middle">${point.label}</text>
    `)
    .join("");

  chartHost.innerHTML = `
    <div class="chart-legend">
      <span><i class="legend-swatch" style="background:#4d8ef7"></i>每天 Token 总量</span>
      <span><i class="legend-swatch" style="background:#4ed0c0"></i>输入 Token</span>
      <span><i class="legend-swatch" style="background:#f56c8c"></i>输出 Token</span>
    </div>
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Token 趋势图">
      ${guideMarkup}
      ${barsMarkup}
      ${labelMarkup}
    </svg>
  `;
}

function renderChart(data) {
  trendTitleNode.textContent = seriesTitle[currentView];
  buildTrendChart(data.series[currentView] || []);
}

function renderMeta(data) {
  codexHomeNode.textContent = data.codexHome;
  timezoneNode.textContent = data.timeZone;
  generatedAtNode.textContent = formatDateTime(data.generatedAt, data.timeZone);
  lastSyncedAtNode.textContent = formatDateTime(data.meta?.syncedAt || data.meta?.receivedAt, data.timeZone);
  dataSourceNode.textContent = data.meta?.source === "synced" ? "云端同步快照" : "本地 SQLite";
  syncButton.disabled = data.meta?.mode !== "local";
  syncButton.title = data.meta?.mode !== "local" ? "只有本地能读取 Codex SQLite 的服务实例才能手动同步" : "把本机最新统计结果同步到线上";
}

function renderDashboard(data) {
  dashboardData = data;
  renderMeta(data);
  renderSummaryCards(data);
  renderInsights(data);
  renderDonut(data);
  renderBreakdown(data);
  renderHighlights(data);
  renderThreadTable(data);
  renderChart(data);
}

async function loadDashboard() {
  refreshButton.disabled = true;
  refreshButton.textContent = "刷新中...";

  try {
    const response = await fetch("/api/usage");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.details || payload.error || "加载失败");
    renderDashboard(payload);
    syncMessageNode.textContent = "";
  } catch (error) {
    chartHost.innerHTML = `<div class="empty-state">${error.message}</div>`;
    syncMessageNode.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "刷新数据";
  }
}

async function manualSync() {
  syncButton.disabled = true;
  syncButton.textContent = "同步中...";
  syncMessageNode.textContent = "正在同步到云端...";

  try {
    const response = await fetch("/api/manual-sync", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.details || payload.error || "同步失败");
    syncMessageNode.textContent = `同步成功：${formatDateTime(payload.syncedAt, dashboardData?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
    await loadDashboard();
  } catch (error) {
    syncMessageNode.textContent = error.message;
  } finally {
    syncButton.disabled = dashboardData?.meta?.mode !== "local";
    syncButton.textContent = "手动同步";
  }
}

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    currentView = button.dataset.view;
    document.querySelectorAll(".segment").forEach((node) => node.classList.toggle("is-active", node === button));
    if (dashboardData) renderChart(dashboardData);
  });
});

refreshButton.addEventListener("click", loadDashboard);
syncButton.addEventListener("click", manualSync);

loadDashboard();
