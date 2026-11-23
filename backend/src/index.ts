import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigError, listenHost, listenPort, loadConfig } from "./config.js";
import { HistoryStore } from "./history.js";
import { Monitor } from "./monitor.js";
import { makeServer } from "./server.js";

function main() {
  let options;
  try {
    options = parseArgs({ options: {
      config: { type: "string", default: "config.toml" },
      host: { type: "string" }, port: { type: "string" }, history: { type: "string" },
      "api-only": { type: "boolean" }, help: { type: "boolean" },
    } }).values;
  } catch {
    throw new ConfigError("Invalid options. See --help.");
  }
  if (options.help) {
    console.log("Usage: npm start -- [--config FILE] [--host HOST] [--port PORT] [--history FILE] [--api-only]");
    return;
  }
  const config = loadConfig(options.config);
  if (options.host !== undefined) config.host = listenHost(options.host);
  if (options.port !== undefined) config.port = listenPort(/^\d+$/.test(options.port) ? Number(options.port) : NaN);
  if (options.history !== undefined) config.historyPath = options.history;
  const monitor = new Monitor(config, new HistoryStore(config.historyPath));
  const web = options["api-only"] || process.env.MONITOR_API_ONLY === "1"
    ? undefined : fileURLToPath(new URL("../../../web/", import.meta.url));
  const server = makeServer(config, () => monitor.snapshot, web);
  server.on("error", () => {
    monitor.stop();
    console.error("Unable to start the monitor server.");
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Monitor listening on ${config.host}:${config.port}`);
    monitor.start();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    monitor.stop();
    server.close();
  });
}
try { main(); }
catch (error) {
  console.error(error instanceof ConfigError ? error.message : "Unable to load monitor assets or configuration.");
  process.exitCode = 1;
}
