/**
 * A tiny key-value store on IndexedDB for offline use: verified manifests, list and story events, keys and drafts.
 * Every call tolerates IndexedDB being unavailable (private windows, blocked storage) by acting as an empty store.
 */
const DB_NAME = "azaadawaaz";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  return (await run<T>("readonly", (s) => s.get(key) as IDBRequest<T>)) ?? undefined;
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await run("readwrite", (s) => s.put(value, key));
}

export async function idbDel(key: string): Promise<void> {
  await run("readwrite", (s) => s.delete(key));
}

/** All keys starting with `prefix`. */
export async function idbKeys(prefix: string): Promise<string[]> {
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  const keys = await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys(range));
  return (keys ?? []).map(String);
}

/** Close and forget the connection (tests). */
export async function idbReset(): Promise<void> {
  const db = await dbPromise;
  db?.close();
  dbPromise = null;
}
