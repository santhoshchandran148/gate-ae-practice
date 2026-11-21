/* ============================================================
 * storage.js — thin wrapper around localStorage + IndexedDB.
 * ============================================================ */
(function () {
  'use strict';
  const NS = 'exam.';
  const KEYS = {
    settings: NS + 'site.v1',
    session:  NS + 'session.v1',
    history:  NS + 'history.v1',
    notes:    NS + 'notes.v1',
    tabLock:  NS + 'tablock.v1',
    customQs: NS + 'customQs.v1' // metadata for custom questions
  };

  let available = true;
  try {
    localStorage.setItem('__probe__', '1');
    localStorage.removeItem('__probe__');
  } catch (e) { available = false; }

  function readJSON(key, fallback) {
    if (!available) return fallback;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    if (!available) return false;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { return false; }
  }

  function remove(key) { if (available) localStorage.removeItem(key); }

  // ---- IndexedDB for Images ----------------------------------------
  const DB_NAME = 'examImagesDB';
  const DB_VERSION = 1;
  let dbPromise = null;

  function getDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images');
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
    return dbPromise;
  }

  async function saveImage(id, blob) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put(blob, id);
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async function getImage(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readonly');
      const req = tx.objectStore('images').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  async function deleteImage(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  // ---- Public API --------------------------------------------------
  const DEFAULT_SETTINGS = { theme: 'auto', negativeMarking: true, passPercent: 50, marking: { mcqWrongFactor: 1/3 } };

  function getSettings() {
    const s = readJSON(KEYS.settings, {});
    return Object.assign({}, DEFAULT_SETTINGS, s, { marking: Object.assign({}, DEFAULT_SETTINGS.marking, s.marking || {}) });
  }
  function setSettings(patch) {
    const next = Object.assign({}, getSettings(), patch || {});
    writeJSON(KEYS.settings, next);
    return next;
  }

  window.Storage = {
    KEYS,
    available: () => available,
    getSettings, setSettings,
    getSession: () => readJSON(KEYS.session, null),
    setSession: (s) => writeJSON(KEYS.session, s),
    clearSession: () => remove(KEYS.session),
    getHistory: () => readJSON(KEYS.history, []),
    setHistory: (h) => writeJSON(KEYS.history, h),
    getNotes: () => readJSON(KEYS.notes, {}),
    setNotes: (n) => writeJSON(KEYS.notes, n),
    getTabLock: () => available ? localStorage.getItem(KEYS.tabLock) : null,
    setTabLock: (id) => { if (available) localStorage.setItem(KEYS.tabLock, id); },
    getCustomQs: () => readJSON(KEYS.customQs, []),
    setCustomQs: (arr) => writeJSON(KEYS.customQs, arr),
    
    // Exposed for Add/Verify pages
    saveImage, getImage, deleteImage
  };
})();