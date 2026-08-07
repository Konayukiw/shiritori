const DB_NAME = "shiritori-bot-web";
const DB_VERSION = 1;
const STORE = "dict-cache";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
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
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
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
    return null;
  }
}

const TX_TIMEOUT_MS = 15000;

export async function cacheSet(key, value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { db.close(); } catch {}
      dbPromise = null;
      finish(reject, new Error(`cacheSet timeout: ${key}`));
    }, TX_TIMEOUT_MS);

    let tx;
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

/**
 * @param {Array<[string, any]>} entries
 * @param {(key: string, error: Error) => void} [onError]
 */

export async function cachePutSeries(entries, onError) {
  const db = await openDb();
  for (const [key, value] of entries) {
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
      });
    } catch (e) {
      if (onError) onError(key, e);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  db.close();
}

export async function cacheDelete(key) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
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
  } catch {
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
    for (const key of targets) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  } catch {
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
