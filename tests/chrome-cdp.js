import { spawn, spawnSync } from "node:child_process";

export function findChrome() {
  if (process.env.FIDGET_CHROME) {
    return process.env.FIDGET_CHROME;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
    const path = found.stdout.trim();
    if (found.status === 0 && path) {
      return path;
    }
  }
  return null;
}

export function launchWithPipe(chrome, args) {
  const proc = spawn(chrome, [
    ...args,
    "--remote-debugging-pipe",
  ], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });

  const closePromise = new Promise((resolve) => proc.once("close", resolve));

  let nextId = 1;
  const pending = new Map();
  const sessionHandlers = new Map();
  let buffer = "";
  let stderrTail = "";
  let closed = false;

  proc.stdio[2].setEncoding("utf8");
  proc.stdio[2].on("data", (chunk) => {
    stderrTail += chunk;
    if (stderrTail.length > 2000) {
      stderrTail = stderrTail.slice(-2000);
    }
  });

  proc.stdio[4].setEncoding("utf8");
  proc.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\0");
    buffer = parts.pop();
    for (const part of parts) {
      if (!part) continue;
      try {
        const msg = JSON.parse(part);

        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            rej(new Error(`CDP error: ${msg.error.message}`));
          } else {
            res(msg.result);
          }
        } else if (msg.method) {
          if (msg.sessionId && sessionHandlers.has(msg.sessionId)) {
            const handlers = sessionHandlers.get(msg.sessionId);
            if (handlers[msg.method]) {
              handlers[msg.method](msg.params);
            }
          }
        }
      } catch (err) {
        console.error(`Failed to parse CDP message: ${err.message}`);
      }
    }
  });

  // Every pending call rejects once Chrome or its pipe goes away.
  function failPending(reason) {
    if (closed) return;
    closed = true;
    const errorMsg = `${reason}${stderrTail ? `. stderr: ${stderrTail.trim()}` : ""}`;
    for (const { reject, method } of pending.values()) {
      reject(new Error(`${method}: ${errorMsg}`));
    }
    pending.clear();
  }

  proc.on("exit", (code) => failPending(`Chrome exited with code ${code}`));
  for (const fd of [3, 4]) {
    proc.stdio[fd].on("error", () => {});
    proc.stdio[fd].on("close", () => failPending("Chrome pipe closed"));
  }

  function send(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`${method}: CDP call timeout after 3s`));
      }, 3000);

      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          res(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          rej(err);
        },
        method,
      });

      proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  }

  function on(sessionId, method, handler) {
    if (!sessionHandlers.has(sessionId)) {
      sessionHandlers.set(sessionId, {});
    }
    sessionHandlers.get(sessionId)[method] = handler;
  }

  function off(sessionId) {
    sessionHandlers.delete(sessionId);
  }

  return { proc, send, on, off, closePromise };
}

export async function createPageTarget(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  return {
    sessionId,
    navigate: (url) => cdp.send("Page.navigate", { url }, sessionId),
    blockURLs: async (urls) => {
      await cdp.send("Network.enable", {}, sessionId);
      await cdp.send("Network.setBlockedURLs", { urls }, sessionId);
    },
  };
}

export async function captureConsoleLog(cdp, sessionId, prefix, timeoutMs, startNavigation) {
  const exceptions = [];
  const logEntries = [];
  const allLogs = [];
  let readyReceived = false;

  cdp.on(sessionId, "Runtime.exceptionThrown", (params) => {
    exceptions.push(params.exceptionDetails);
  });

  cdp.on(sessionId, "Log.entryAdded", (params) => {
    logEntries.push(params.entry);
  });

  return new Promise((resolve, reject) => {
    let readyTimer = null;
    let resultTimer = null;

    const cleanup = () => {
      if (readyTimer) clearTimeout(readyTimer);
      if (resultTimer) clearTimeout(resultTimer);
      cdp.off(sessionId);
    };

    const buildError = (msg) => {
      const errorParts = [msg];
      if (allLogs.length > 0) {
        errorParts.push(`Console logs: ${allLogs.join(", ")}`);
      }
      if (exceptions.length > 0) {
        errorParts.push(`Exceptions: ${exceptions.map(e => e.text || e.exception?.description || JSON.stringify(e)).join("; ")}`);
      }
      if (logEntries.length > 0) {
        errorParts.push(`Log entries: ${logEntries.map(e => `[${e.level}] ${e.text}`).join("; ")}`);
      }
      return new Error(errorParts.join(". "));
    };

    cdp.on(sessionId, "Runtime.consoleAPICalled", (params) => {
      if (params.type === "log" && params.args.length > 0) {
        const value = params.args[0].value;
        if (typeof value === "string") {
          allLogs.push(value);
          if (value.startsWith(prefix)) {
            cleanup();
            try {
              resolve(JSON.parse(value.slice(prefix.length)));
            } catch (err) {
              reject(new Error(`failed to parse console.log payload: ${err.message}`));
            }
          } else if (!readyReceived && value.startsWith("__PROBE_READY__")) {
            readyReceived = true;
            clearTimeout(readyTimer);
            resultTimer = setTimeout(() => {
              cleanup();
              reject(buildError(`no console.log with prefix "${prefix}" within ${timeoutMs}ms (probe timed out)`));
            }, timeoutMs);
          }
        }
      }
    });

    Promise.resolve(startNavigation()).catch(reject);

    readyTimer = setTimeout(() => {
      cleanup();
      reject(buildError(`no console.log with prefix "__PROBE_READY__" within ${timeoutMs}ms (page never loaded)`));
    }, timeoutMs);
  });
}

export async function cleanupChrome(cdp) {
  if (cdp.proc.exitCode !== null || cdp.proc.signalCode !== null) {
    return;
  }
  cdp.proc.kill("SIGKILL");
  let timer;
  const capped = new Promise((resolve) => { timer = setTimeout(resolve, 3000); });
  try { await Promise.race([cdp.closePromise, capped]); } finally { clearTimeout(timer); }
}
