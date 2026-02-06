import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";
import { createApiServer } from "./api.js";
import { startPoller } from "./poller.js";
import { startSubmitter } from "./submitter.js";

const config = loadConfig();

// Ensure DB directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

const store = createStore(config.dbPath);

// Start HTTP API
const app = createApiServer(config, store);
const server = app.listen(config.apiPort, () => {
  console.log(`HTTP API listening on port ${config.apiPort}`);
});

// Start background loops
startPoller(config, store);
startSubmitter(config, store);

console.log("XReserve Relay Indexer started");

// Graceful shutdown
function shutdown() {
  console.log("Shutting down...");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
