const { parentPort, workerData } = require("node:worker_threads");
const { prepareWritableEngineBundle } = require("./store-engine-cache");

function prepare(options, send) {
try {
  const result = prepareWritableEngineBundle({
    ...options,
    log: (message, error) => send({ type: "log", message,
      error: error ? String(error.message || error) : undefined })
  });
  send({ type: "result", result });
} catch (error) {
  send({ type: "failure", reason: String(error.message || error) });
}
}

if (parentPort) prepare(workerData, message => parentPort.postMessage(message));
else process.once("message", options => {
  prepare(options, message => process.send(message));
  process.disconnect();
});
