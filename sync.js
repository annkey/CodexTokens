const os = require("node:os");
const { buildUsageSnapshot } = require("./server");

const targetUrl = process.env.SYNC_TARGET_URL;
const syncToken = process.env.SYNC_TOKEN || "";
const codexHome = process.env.CODEX_HOME;

if (!targetUrl) {
  console.error("Missing SYNC_TARGET_URL environment variable.");
  process.exit(1);
}

async function main() {
  const snapshot = buildUsageSnapshot(codexHome ? { codexHome } : {});
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(syncToken ? { Authorization: `Bearer ${syncToken}` } : {}),
    },
    body: JSON.stringify({
      syncedAt: new Date().toISOString(),
      machineName: os.hostname(),
      snapshot,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.details || payload.error || `Sync failed with status ${response.status}`);
  }

  console.log(`Synced successfully at ${payload.savedAt || "unknown time"}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
