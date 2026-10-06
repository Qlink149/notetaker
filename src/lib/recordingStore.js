// Durable storage for an in-progress recording. Each audio chunk is written
// here as it arrives (every couple of seconds), so if the tab is killed, the
// phone frees memory, or the screen locks, everything captured up to the
// last saved chunk survives and can be recovered on the next load.
const DB_NAME = "meetingid_recording";
const CHUNKS = "chunks";
const META = "meta";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: "seq" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveChunk(blob, seq) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS, "readwrite");
    tx.objectStore(CHUNKS).put({ seq, blob, ts: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function setMeta(meta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META, "readwrite");
    tx.objectStore(META).put({ id: "current", ...meta });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META, "readonly");
    const req = tx.objectStore(META).get("current");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllChunks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNKS, "readonly");
    const req = tx.objectStore(CHUNKS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function clearRecording() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CHUNKS, META], "readwrite");
    tx.objectStore(CHUNKS).clear();
    tx.objectStore(META).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}