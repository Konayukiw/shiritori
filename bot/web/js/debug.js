const WEBHOOK_URL = "https://discord.com/api/webhooks/1535304513228120075/XECHgs8QAt2kN1EB-97sjYWknSKIST3CSrrNgMinETdeaDxYSDsZ2VE2UYnGZdYq5NDi";

const LOG_USERNAME = "shiritori-web";

const FLUSH_INTERVAL_MS = 1500;
const MAX_CONTENT = 1950;
const MAX_LINE = 1500;

let queue = [];
let flushTimer = null;
let sending = false;
let envSent = false;
let globalInstalled = false;

function envTag() {
  try {
    return `${navigator.platform || "?"} / ${navigator.userAgent}`;
  } catch {
    return "ua-unknown";
  }
}

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

async function flush() {
  if (sending || !WEBHOOK_URL || queue.length === 0) return;
  sending = true;

  if (!envSent) {
    queue.unshift(`__**session**__ \`${envTag()}\``);
    envSent = true;
  }

  const batch = [];
  let size = 0;
  while (queue.length) {
    const line = queue[0];
    const add = (size ? 1 : 0) + line.length;
    if (size + add > MAX_CONTENT && batch.length) break;
    batch.push(queue.shift());
    size += add;
  }
  const content = batch.join("\n");

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: LOG_USERNAME, content }),
      keepalive: true,
    });
    if (res.status === 429) {
      queue.unshift(...batch);
      let wait = 2000;
      try {
        const d = await res.json();
        if (d && d.retry_after) wait = Math.ceil(d.retry_after * 1000) + 250;
      } catch {}
      setTimeout(() => {
        sending = false;
        flush();
      }, wait);
      return;
    }
  } catch {
  }

  sending = false;
  if (queue.length) scheduleFlush();
}

/**
 * @param {string} message
 * @param {"error"|"warn"|"info"} [level]
 */

export function sendWebhook(message, level = "error") {
  try {
    if (level === "error") console.error(message);
    else if (level === "warn") console.warn(message);
    else console.info(message);
  } catch {}

  if (!WEBHOOK_URL) return;

  const icon = level === "error" ? "🔴" : level === "warn" ? "🟡" : "🔵";
  const time = new Date().toISOString().slice(11, 19);
  let text = String(message);
  if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + "…(truncated)";
  queue.push(`${icon} \`${time}\` ${text}`);
  scheduleFlush();
}

export function installGlobalWebhookLogging() {
  if (globalInstalled || typeof window === "undefined") return;
  globalInstalled = true;

  window.addEventListener("error", (e) => {
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    const msg = e.error && e.error.stack ? e.error.stack : e.message;
    sendWebhook(`window.onerror: ${msg}${where}`, "error");
  });

  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = r && r.stack ? r.stack : r && r.message ? r.message : String(r);
    sendWebhook(`unhandledrejection: ${msg}`, "error");
  });
}
