// IndexedDB cache for chart drawings and FX analysis. Keep browser-local backups
// across reloads without exhausting the small synchronous localStorage quota.
// All migrations are copy-verified; a legacy key is only deleted after a
// successful IndexedDB transaction, never before.
const DB_NAME = "trading-terminal-chart-cache-v1";
const STORE_NAME = "documents";
const LEGACY_PREFIXES = [
  "chart.fxAnalysis.v1.",
  "chart.drawings.v1.",
  "chart.market-structure.v1.",
];

let dbPromise: Promise<IDBDatabase> | null = null;
let migrationPromise: Promise<void> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

async function readDb(key: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

async function writeDb(key: string, value: string, onlyIfAbsent = false): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    if (onlyIfAbsent) {
      const read = store.get(key);
      read.onsuccess = () => {
        if (read.result === undefined) store.put(value, key);
      };
    } else {
      store.put(value, key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
  });
}

function legacyGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function legacyRemoveIfUnchanged(key: string, expected: string): void {
  try {
    if (window.localStorage.getItem(key) === expected) window.localStorage.removeItem(key);
  } catch { /* Safe to retain the legacy copy. */ }
}

/** Recover older chart data before freeing legacy space. */
export function migrateLegacyChartStorage(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      if (typeof window === "undefined") return;
      let keys: string[] = [];
      try {
        keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))
          .filter((key): key is string => !!key && LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix)));
      } catch { return; }
      for (const key of keys) {
        const value = legacyGet(key);
        if (value === null) continue;
        try {
          await writeDb(key, value, true);
          // If IndexedDB already had this key, its copy may be newer. Don't
          // overwrite that version with an old localStorage snapshot.
          legacyRemoveIfUnchanged(key, value);
        } catch (error) {
          console.warn("[ChartCache] migration retained legacy key", key, error);
          return; // Never delete remaining keys when IndexedDB is unavailable.
        }
      }
    })().finally(() => { migrationPromise = null; });
  }
  return migrationPromise;
}

/** Load the durable chart cache; fall back to a legacy key if necessary. */
export async function readLargeChartDocument(key: string): Promise<string | null> {
  try {
    const fromDb = await readDb(key);
    if (fromDb !== null) return fromDb;
  } catch (error) {
    console.warn("[ChartCache] IndexedDB read unavailable", error);
  }
  return typeof window === "undefined" ? null : legacyGet(key);
}

/** Save chart data without writing large payloads into localStorage. */
export async function writeLargeChartDocument(key: string, value: string): Promise<void> {
  await writeDb(key, value);
  if (typeof window !== "undefined") {
    const legacy = legacyGet(key);
    if (legacy !== null) legacyRemoveIfUnchanged(key, legacy);
  }
}
