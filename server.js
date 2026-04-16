const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3210);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "usage-snapshot.json");
const LAST_SYNC_STATE_FILE = path.join(DATA_DIR, "last-sync-state.json");
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const SYNC_TARGET_URL = process.env.SYNC_TARGET_URL || "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function getTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function resolveAllLogsDbPaths(codexHome) {
  return fs
    .readdirSync(codexHome, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^logs_\d+\.sqlite$/i.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(codexHome, entry.name);
      const stat = fs.statSync(fullPath);
      const match = entry.name.match(/^logs_(\d+)\.sqlite$/i);
      return {
        fullPath,
        size: stat.size,
        sequence: match ? Number(match[1]) : 0,
      };
    })
    .filter((item) => item.size > 0)
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => item.fullPath);
}

function hasLocalCodexData() {
  const logDbPaths = resolveAllLogsDbPaths(DEFAULT_CODEX_HOME);
  const stateDbPath = path.join(DEFAULT_CODEX_HOME, "state_5.sqlite");
  return logDbPaths.length > 0 && fs.existsSync(stateDbPath);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStoredSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
}

function writeStoredSnapshot(snapshot) {
  ensureDataDir();
  fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function writeLastSyncState(timestamp = new Date()) {
  ensureDataDir();
  fs.writeFileSync(
    LAST_SYNC_STATE_FILE,
    `${JSON.stringify(
      {
        lastSuccessfulSyncUtc: timestamp.toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function withMeta(snapshot, overrides = {}) {
  return {
    ...snapshot,
    meta: {
      source: "local",
      syncedAt: null,
      receivedAt: null,
      machineName: os.hostname(),
      mode: "local",
      ...snapshot.meta,
      ...overrides,
    },
  };
}

function getLocalDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function getDateKey(date, timeZone) {
  const { year, month, day } = getLocalDateParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getMonthKey(date, timeZone) {
  const { year, month } = getLocalDateParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function getWeekKeyFromDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - dayOfWeek + 1);
  return `${utcDate.getUTCFullYear()}-${String(utcDate.getUTCMonth() + 1).padStart(2, "0")}-${String(utcDate.getUTCDate()).padStart(2, "0")}`;
}

function shiftDateKey(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function shiftMonthKey(monthKey, amount) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + amount);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function rangeFromEnd(endKey, count, stepFn) {
  const items = [];
  let cursor = endKey;
  for (let index = 0; index < count; index += 1) {
    items.unshift(cursor);
    cursor = stepFn(cursor, -1);
  }
  return items;
}

function percentageChange(current, previous) {
  if (!previous) {
    return current ? 100 : 0;
  }
  return ((current - previous) / previous) * 100;
}

function parseCompletedEvent(body) {
  if (!body || !body.includes("event.kind=response.completed") || !body.includes("input_token_count=")) {
    return null;
  }

  const readNumber = (field) => {
    const match = body.match(new RegExp(`${field}=(\\d+)`));
    return match ? Number(match[1]) : 0;
  };

  const readString = (field) => {
    const match = body.match(new RegExp(`${field}=(?:"([^"]+)"|([^\\s]+))`));
    return match ? match[1] || match[2] : "";
  };

  const timestamp = readString("event.timestamp");
  if (!timestamp) {
    return null;
  }

  return {
    timestamp,
    conversationId: readString("conversation.id"),
    model: readString("model") || "unknown",
    input: readNumber("input_token_count"),
    output: readNumber("output_token_count"),
    cached: readNumber("cached_token_count"),
    reasoning: readNumber("reasoning_token_count"),
    tool: readNumber("tool_token_count"),
  };
}

function sumEventTokens(event) {
  return event.input + event.output + event.cached + event.reasoning + event.tool;
}

function createEmptyBucket(key, label) {
  return {
    key,
    label,
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    tool: 0,
    count: 0,
  };
}

function addEventToBucket(bucket, event) {
  bucket.total += sumEventTokens(event);
  bucket.input += event.input;
  bucket.output += event.output;
  bucket.cached += event.cached;
  bucket.reasoning += event.reasoning;
  bucket.tool += event.tool;
  bucket.count += 1;
}

function sortAndLimitTotals(map, limit, formatter) {
  return [...map.entries()]
    .map(([key, value]) => formatter(key, value))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

function buildUsageSnapshot(options = {}) {
  const codexHome = options.codexHome || DEFAULT_CODEX_HOME;
  const logDbPaths = resolveAllLogsDbPaths(codexHome);
  const stateDbPath = path.join(codexHome, "state_5.sqlite");
  const timeZone = getTimezone();
  const now = new Date();
  const todayKey = getDateKey(now, timeZone);
  const thisWeekKey = getWeekKeyFromDateKey(todayKey);
  const thisMonthKey = getMonthKey(now, timeZone);
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const previousWeekKey = shiftDateKey(thisWeekKey, -7);
  const previousMonthKey = shiftMonthKey(thisMonthKey, -1);

  const dailyKeys = rangeFromEnd(todayKey, 30, shiftDateKey);
  const weeklyKeys = rangeFromEnd(thisWeekKey, 12, (key, amount) => shiftDateKey(key, amount * 7));
  const monthlyKeys = rangeFromEnd(thisMonthKey, 12, shiftMonthKey);

  const dailyMap = new Map(dailyKeys.map((key) => [key, createEmptyBucket(key, key.slice(5))]));
  const weeklyMap = new Map(weeklyKeys.map((key) => [key, createEmptyBucket(key, key.slice(5))]));
  const monthlyMap = new Map(monthlyKeys.map((key) => [key, createEmptyBucket(key, key)]));

  const allDailyMap = new Map();
  const allWeeklyMap = new Map();
  const allMonthlyMap = new Map();
  const modelTotals = new Map();
  const cwdTotals = new Map();

  const categoryTotals = { total: 0, input: 0, output: 0, cached: 0, reasoning: 0, tool: 0, count: 0 };
  const summaries = {
    today: createEmptyBucket(todayKey, "today"),
    thisWeek: createEmptyBucket(thisWeekKey, "thisWeek"),
    thisMonth: createEmptyBucket(thisMonthKey, "thisMonth"),
    allTime: createEmptyBucket("all", "all"),
  };

  const dedupedEvents = [];
  const seen = new Set();

  for (const logDbPath of logDbPaths) {
    const logsDb = new DatabaseSync(logDbPath, { readonly: true });
    const logRows = logsDb
      .prepare(
        `SELECT feedback_log_body
         FROM logs
         WHERE feedback_log_body IS NOT NULL
           AND feedback_log_body LIKE '%event.kind=response.completed%'
           AND feedback_log_body LIKE '%input_token_count=%'
         ORDER BY ts ASC`,
      )
      .all();

    for (const row of logRows) {
      const event = parseCompletedEvent(row.feedback_log_body);
      if (!event) {
        continue;
      }

      const dedupeKey = [
        event.timestamp,
        event.conversationId,
        event.input,
        event.output,
        event.cached,
        event.reasoning,
        event.tool,
      ].join("|");

      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      dedupedEvents.push(event);
    }

    logsDb.close();
  }

  const stateDb = new DatabaseSync(stateDbPath, { readonly: true });
  const threadRows = stateDb
    .prepare(
      `SELECT id, title, cwd, model, tokens_used, updated_at
       FROM threads
       WHERE archived = 0
       ORDER BY tokens_used DESC`,
    )
    .all();
  stateDb.close();

  const threadTotals = threadRows.reduce(
    (accumulator, row) => {
      accumulator.totalTokens += row.tokens_used || 0;
      accumulator.threadCount += 1;
      return accumulator;
    },
    { totalTokens: 0, threadCount: 0 },
  );

  const threadMap = new Map(
    threadRows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.title,
        cwd: row.cwd,
        model: row.model || "unknown",
        tokensUsed: row.tokens_used,
        updatedAt: row.updated_at,
      },
    ]),
  );

  let peakResponse = null;

  for (const event of dedupedEvents) {
    const total = sumEventTokens(event);
    const eventDate = new Date(event.timestamp);
    const dateKey = getDateKey(eventDate, timeZone);
    const weekKey = getWeekKeyFromDateKey(dateKey);
    const monthKey = getMonthKey(eventDate, timeZone);
    const thread = threadMap.get(event.conversationId);
    const cwd = thread?.cwd || "Unknown Project";

    if (!allDailyMap.has(dateKey)) allDailyMap.set(dateKey, createEmptyBucket(dateKey, dateKey));
    if (!allWeeklyMap.has(weekKey)) allWeeklyMap.set(weekKey, createEmptyBucket(weekKey, weekKey));
    if (!allMonthlyMap.has(monthKey)) allMonthlyMap.set(monthKey, createEmptyBucket(monthKey, monthKey));

    addEventToBucket(allDailyMap.get(dateKey), event);
    addEventToBucket(allWeeklyMap.get(weekKey), event);
    addEventToBucket(allMonthlyMap.get(monthKey), event);

    if (dailyMap.has(dateKey)) addEventToBucket(dailyMap.get(dateKey), event);
    if (weeklyMap.has(weekKey)) addEventToBucket(weeklyMap.get(weekKey), event);
    if (monthlyMap.has(monthKey)) addEventToBucket(monthlyMap.get(monthKey), event);

    addEventToBucket(summaries.allTime, event);
    if (dateKey === todayKey) addEventToBucket(summaries.today, event);
    if (weekKey === thisWeekKey) addEventToBucket(summaries.thisWeek, event);
    if (monthKey === thisMonthKey) addEventToBucket(summaries.thisMonth, event);

    categoryTotals.total += total;
    categoryTotals.input += event.input;
    categoryTotals.output += event.output;
    categoryTotals.cached += event.cached;
    categoryTotals.reasoning += event.reasoning;
    categoryTotals.tool += event.tool;
    categoryTotals.count += 1;

    modelTotals.set(event.model, (modelTotals.get(event.model) || 0) + total);
    cwdTotals.set(cwd, (cwdTotals.get(cwd) || 0) + total);

    if (!peakResponse || total > peakResponse.total) {
      peakResponse = {
        total,
        timestamp: event.timestamp,
        model: event.model,
        conversationId: event.conversationId,
        title: thread?.title || "Unknown Thread",
      };
    }
  }

  const topThreads = threadRows.slice(0, 5).map((row) => ({
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    model: row.model || "unknown",
    tokensUsed: row.tokens_used,
    updatedAt: row.updated_at,
  }));

  const peakDay = [...dailyMap.values()].reduce((best, item) => (item.total > best.total ? item : best), createEmptyBucket("", ""));
  const peakWeek = [...weeklyMap.values()].reduce((best, item) => (item.total > best.total ? item : best), createEmptyBucket("", ""));
  const peakMonth = [...monthlyMap.values()].reduce((best, item) => (item.total > best.total ? item : best), createEmptyBucket("", ""));

  const previousDayTotal = allDailyMap.get(yesterdayKey)?.total || 0;
  const previousWeekTotal = allWeeklyMap.get(previousWeekKey)?.total || 0;
  const previousMonthTotal = allMonthlyMap.get(previousMonthKey)?.total || 0;
  const lastSevenDays = [...allDailyMap.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(-7);
  const averageResponseTokens = categoryTotals.count ? categoryTotals.total / categoryTotals.count : 0;
  const activeDays = [...allDailyMap.values()].filter((item) => item.total > 0).length;
  const cacheRatio = categoryTotals.total ? (categoryTotals.cached / categoryTotals.total) * 100 : 0;

  summaries.allTime.total = threadTotals.totalTokens;
  summaries.allTime.count = threadTotals.threadCount;

  return withMeta({
    generatedAt: new Date().toISOString(),
    timeZone,
    codexHome,
    summaryCards: {
      today: summaries.today,
      thisWeek: summaries.thisWeek,
      thisMonth: summaries.thisMonth,
      allTime: summaries.allTime,
    },
    highlights: {
      peakDay,
      peakWeek,
      peakMonth,
      totalResponses: categoryTotals.count,
    },
    categoryTotals,
    analytics: {
      dayOverDay: percentageChange(summaries.today.total, previousDayTotal),
      weekOverWeek: percentageChange(summaries.thisWeek.total, previousWeekTotal),
      monthOverMonth: percentageChange(summaries.thisMonth.total, previousMonthTotal),
      movingAverage7d: lastSevenDays.length
        ? lastSevenDays.reduce((sum, item) => sum + item.total, 0) / lastSevenDays.length
        : 0,
      cacheRatio,
      averageResponseTokens,
      peakResponse: peakResponse || {
        total: 0,
        timestamp: "",
        model: "unknown",
        conversationId: "",
        title: "Unknown Thread",
      },
      activeDays,
      modelRanking: sortAndLimitTotals(modelTotals, 5, (key, value) => ({ key, label: key, total: value })),
      projectRanking: sortAndLimitTotals(cwdTotals, 5, (key, value) => ({ key, label: key, total: value })),
    },
    series: {
      daily: [...dailyMap.values()],
      weekly: [...weeklyMap.values()],
      monthly: [...monthlyMap.values()],
    },
    topThreads,
  });
}

function resolveUsageSnapshot() {
  if (hasLocalCodexData()) {
    return buildUsageSnapshot();
  }

  const storedSnapshot = readStoredSnapshot();
  if (storedSnapshot) {
    return withMeta(storedSnapshot, {
      source: "synced",
      mode: "remote",
    });
  }

  throw new Error("No local Codex SQLite files found and no synced snapshot is available.");
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });
  response.end(JSON.stringify(data));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

function isAuthorized(request) {
  if (!SYNC_TOKEN) {
    return true;
  }

  const authHeader = request.headers.authorization || "";
  return authHeader === `Bearer ${SYNC_TOKEN}`;
}

async function pushSnapshotToTarget(snapshot) {
  if (!SYNC_TARGET_URL) {
    throw new Error("SYNC_TARGET_URL is not configured on this server.");
  }

  const response = await fetch(SYNC_TARGET_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SYNC_TOKEN ? { Authorization: `Bearer ${SYNC_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      syncedAt: new Date().toISOString(),
      machineName: os.hostname(),
      snapshot,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.details || payload.error || `Manual sync failed with status ${response.status}`);
  }

  return payload;
}

function handleSyncRequest(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: "Unauthorized sync request." });
    return;
  }

  readRequestBody(request)
    .then((raw) => {
      const payload = JSON.parse(raw || "{}");
      if (!payload || typeof payload !== "object" || !payload.snapshot) {
        throw new Error("Missing snapshot payload.");
      }

      const snapshot = withMeta(payload.snapshot, {
        source: "synced",
        mode: "remote",
        syncedAt: payload.syncedAt || new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        machineName: payload.machineName || payload.snapshot?.meta?.machineName || "unknown",
      });

      writeStoredSnapshot(snapshot);
      sendJson(response, 200, {
        ok: true,
        savedAt: snapshot.meta.receivedAt,
        source: snapshot.meta.source,
      });
    })
    .catch((error) => {
      sendJson(response, 400, {
        error: "Failed to store synced snapshot.",
        details: error.message,
      });
    });
}

function handleManualSyncRequest(response) {
  if (!hasLocalCodexData()) {
    sendJson(response, 400, {
      error: "Manual sync is only available on a machine that can read local Codex SQLite files.",
    });
    return;
  }

  const snapshot = buildUsageSnapshot();
  pushSnapshotToTarget(snapshot)
    .then((payload) => {
      writeLastSyncState(new Date());
      sendJson(response, 200, {
        ok: true,
        syncedAt: payload.savedAt || new Date().toISOString(),
        target: SYNC_TARGET_URL,
      });
    })
    .catch((error) => {
      sendJson(response, 400, {
        error: "Failed to manually sync usage snapshot.",
        details: error.message,
      });
    });
}

function serveStaticFile(requestPath, response) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const normalizedPath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(content);
  });
}

function createServer() {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && requestUrl.pathname === "/api/usage") {
      try {
        sendJson(response, 200, resolveUsageSnapshot());
      } catch (error) {
        sendJson(response, 500, {
          error: "Failed to load usage data.",
          details: error.message,
          codexHome: DEFAULT_CODEX_HOME,
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/sync") {
      handleSyncRequest(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/manual-sync") {
      handleManualSyncRequest(response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        hasLocalCodexData: hasLocalCodexData(),
        hasStoredSnapshot: fs.existsSync(SNAPSHOT_FILE),
        mode: hasLocalCodexData() ? "local" : "remote",
        canManualSync: Boolean(hasLocalCodexData() && SYNC_TARGET_URL),
        syncTargetConfigured: Boolean(SYNC_TARGET_URL),
      });
      return;
    }

    serveStaticFile(requestUrl.pathname, response);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Codex token dashboard is running at http://localhost:${PORT}`);
    console.log(`Default Codex data source: ${DEFAULT_CODEX_HOME}`);
    console.log(`Mode: ${hasLocalCodexData() ? "local SQLite" : "synced snapshot fallback"}`);
  });
}

module.exports = {
  buildUsageSnapshot,
  createServer,
  resolveUsageSnapshot,
  writeLastSyncState,
};
