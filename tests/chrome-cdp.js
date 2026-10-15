import { spawn, spawnSync } from "node:child_process";

export function findChrome() {
  if (process.env.FIDGET_CHROME) return process.env.FIDGET_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" });
    const path = found.stdout.trim();
    if (found.status === 0 && path) return path;
  }
  return null;
}

export async function launchWithPipe(chromePath, args) {
  const child = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });

  let stdoutData = "";
  let stderrData = "";

  child.stdout.on("data", (chunk) => {
    stdoutData += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  const wsMatch = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome did not print WebSocket URL")), 3000);

    const checkForWs = () => {
      const match = stderrData.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };

    child.stderr.on("data", checkForWs);
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const ws = new WebSocket(wsMatch);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  let seq = 0;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      const { sessionId, ...rest } = params;
      if (sessionId) {
        ws.send(JSON.stringify({ id, method, params: rest, sessionId }));
      } else {
        ws.send(JSON.stringify({ id, method, params }));
      }
    });

  return { child, ws, send };
}

export async function createPageTarget(cdp) {
  const { result } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const targetId = result.targetId;

  const { result: attachResult } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const sessionId = attachResult.sessionId;

  await cdp.send("Page.enable", { sessionId });
  await cdp.send("Runtime.enable", { sessionId });

  const navigate = async (url) => {
    await cdp.send("Page.navigate", { sessionId, url });
  };

  return { sessionId, navigate };
}

export async function captureConsoleLog(cdp, sessionId, marker, timeoutMs, navigateFn) {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${marker} not seen within ${timeoutMs} ms`));
    }, timeoutMs);

    const messageHandler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.args) {
        for (const arg of msg.params.args) {
          if (arg.value && typeof arg.value === "string" && arg.value.startsWith(marker)) {
            clearTimeout(timeout);
            cdp.ws.removeEventListener("message", messageHandler);
            const result = arg.value.slice(marker.length);
            try {
              resolve(JSON.parse(result));
            } catch {
              resolve(result);
            }
            return;
          }
        }
      }
    };

    cdp.ws.addEventListener("message", messageHandler);

    await navigateFn();
  });
}

export async function cleanupChrome(cdp) {
  cdp.ws.close();
  cdp.child.kill("SIGKILL");
  await new Promise((resolve) => {
    cdp.child.once("exit", resolve);
  });
}
