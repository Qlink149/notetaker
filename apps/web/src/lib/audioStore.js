// Client-side audio cache so recorded/uploaded meeting audio is playable on
// the detail page without external file hosting. Keyed by meeting id, same device.
const DB_NAME = "meetingid-audio";
const STORE = "clips";
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMeetingAudio(meetingId, blob) {
  if (!meetingId || !blob) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, meetingId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // storage full or unavailable — playback is best-effort
  }
}

export async function deleteMeetingAudio(meetingId) {
  if (!meetingId) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(meetingId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
}

export async function getMeetingAudioUrl(meetingId) {
  if (!meetingId) return null;
  try {
    const db = await openDb();
    const blob = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(meetingId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}