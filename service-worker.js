// AG-999 Service Worker v2026
// Handles: offline caching, IndexedDB outbox, background sync

const CACHE_NAME = 'ag999-v2026-v1';
const SYNC_TAG   = 'ag999-sync-reports';

// Files to cache for full offline operation
const PRECACHE = [
  '/ag999-frontend/ag999_v8.html',
  '/ag999-frontend/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://basemaps.cartocdn.com/rastertiles/voyager/0/0/0.png', // seed tile cache
];

// ── INSTALL — pre-cache app shell ────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE).catch(err => {
        console.warn('SW: some precache files failed (ok):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE — clean old caches ──────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH — serve from cache when offline ────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Skip non-GET and Firebase/API requests (handle separately)
  if (event.request.method !== 'GET') return;
  if (url.includes('firebaseio.com') || url.includes('onrender.com')) return;
  if (url.includes('firestore.googleapis.com')) return;

  // Map tiles — cache with network-first strategy
  if (url.includes('cartocdn.com') || url.includes('openstreetmap.org')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        try {
          const response = await fetch(event.request);
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        } catch {
          return cache.match(event.request);
        }
      })
    );
    return;
  }

  // App shell — cache-first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/ag999-frontend/ag999_v8.html');
        }
      });
    })
  );
});

// ── BACKGROUND SYNC — send queued reports ────────────
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncOutbox());
  }
});

// ── PERIODIC SYNC (if supported) ─────────────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncOutbox());
  }
});

// ── OUTBOX SYNC FUNCTION ─────────────────────────────
async function syncOutbox() {
  const db = await openIDB();
  const reports = await getAllFromStore(db, 'outbox');

  if (!reports.length) return;

  const FIREBASE_URL = 'https://firestore.googleapis.com/v1/projects/ag999-crisis-engine/databases/(default)/documents/reports';

  let synced = 0;
  for (const report of reports) {
    try {
      // Convert to Firestore REST format
      const fields = {};
      Object.entries(report.data).forEach(([k, v]) => {
        if (typeof v === 'number') fields[k] = { doubleValue: v };
        else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
        else if (v === null || v === undefined) fields[k] = { nullValue: null };
        else fields[k] = { stringValue: String(v) };
      });

      const res = await fetch(FIREBASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });

      if (res.ok) {
        await deleteFromStore(db, 'outbox', report.id);
        synced++;
      }
    } catch (e) {
      console.warn('SW: sync failed for report', report.id, e);
    }
  }

  // Notify clients of sync completion
  if (synced > 0) {
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({
      type: 'SYNC_COMPLETE',
      synced,
      remaining: reports.length - synced
    }));
  }
}

// ── INDEXEDDB HELPERS ─────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ag999-offline', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function getAllFromStore(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror = e => reject(e.target.error);
  });
}

function deleteFromStore(db, store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}
