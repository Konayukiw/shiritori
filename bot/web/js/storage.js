import { sendWebhook } from "./debug.js";

const DB_NAME = "shiritori-bot-web";
const DB_VERSION = 1;
const STORE = "dict-cache";
const TX_TIMEOUT_MS = 15000;

let dbPromise = null;
let dbGeneration = 0;

function reportTxFailure(context, key, e) {
  const name = e && e.name ? e.name : "UnknownError";
  const msg = e && e.message ? e.message : String(e);
  sendWebhook(`storage.js ${context} 失敗 [${key}]: ${name}: ${msg}`, "warn");
}

function invalidateDb() {
  dbPromise = null;
}

function openDb() {
  if (dbPromise) return dbPromise;
  const gen = ++dbGeneration;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        if (gen === dbGeneration) dbPromise = null;
      };
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
      };
      resolve(db);
    };
    req.onerror = () => {
      if (gen === dbGeneration) dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    reportTxFailure("cacheGet", key, e);
    return null;
  }
}

function putOnce(db, key, value) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tx = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try {
        if (tx) tx.abort();
      } catch {}
      finish(reject, new Error(`cacheSet timeout: ${key}`));
    }, TX_TIMEOUT_MS);

    try {
      tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
    } catch (e) {
      finish(reject, e);
      return;
    }
    tx.oncomplete = () => finish(resolve);
    tx.onerror = () => finish(reject, tx.error || new Error("tx error"));
    tx.onabort = () => finish(reject, tx.error || new Error("tx aborted"));
  });
}

export async function cacheSet(key, value) {
  let db;
  try {
    db = await openDb();
    return await putOnce(db, key, value);
  } catch (first) {
    if (first && first.name === "QuotaExceededError") {
      reportTxFailure("cacheSet", key, first);
      throw first;
    }
    invalidateDb();
    try {
      db = await openDb();
      await putOnce(db, key, value);
    } catch (second) {
      reportTxFailure("cacheSet", key, second);
      throw second;
    }
  }
}

/**
 * @param {Array<[string, any]>} entries
 * @param {(key: string, error: Error) => void} [onError]
 */

export async function cacheDelete(key) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  } catch (e) {
    reportTxFailure("cacheDelete", key, e);
  }
}

export async function cacheKeys() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    reportTxFailure("cacheKeys", "(all)", e);
    return [];
  }
}

export async function cacheDeleteByPrefix(prefix) {
  try {
    const db = await openDb();
    const keys = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const targets = keys.filter((k) => String(k).startsWith(prefix));
    if (!targets.length) return;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const key of targets) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
    });
  } catch (e) {
    reportTxFailure("cacheDeleteByPrefix", prefix, e);
  }
}

export async function storagePersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch {
  }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      return await navigator.storage.estimate();
    }
  } catch {
  }
  return { usage: 0, quota: Infinity };
}