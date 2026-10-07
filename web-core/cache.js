// Offline media cache. Keeps each ad's file in IndexedDB so the player keeps going when the
// backend or the network disappears. IndexedDB is used (not Service Workers / Cache API) because
// those only work on https, and a TV opens the backend over plain http on the local network.
//
// Plain ES5 like the rest of web-core. If IndexedDB is missing or blocked, AdCache.available is
// false and everything simply streams from the backend as before.
(function () {
  var cfg = window.TV_CONFIG || {};
  var API = cfg.apiBase || '';
  var RETRY_MS = 60000;

  var db = null;
  var busy = false;        // one download at a time, so the TV's bandwidth and memory are not swamped
  var queued = null;       // newest manifest that arrived while busy
  var lastManifest = null;
  var retryTimer = null;
  var status = {};         // ad id -> { state: 'ready' | 'downloading' | 'waiting' | 'nospace' | 'error', pct: n }

  var AdCache = { available: !!window.indexedDB, onChange: null };

  function notify() { if (AdCache.onChange) { try { AdCache.onChange(); } catch (e) {} } }

  // The file on Drive "is the same" when its checksum (or modified time) and size match.
  function stamp(ad) { return (ad.md5 || String(ad.modifiedTime)) + ':' + ad.sizeBytes; }

  function open(cb) {
    if (db) { cb(true); return; }
    if (!AdCache.available) { cb(false); return; }
    var req;
    try { req = window.indexedDB.open('tvads', 1); } catch (e) { AdCache.available = false; cb(false); return; }
    req.onupgradeneeded = function () {
      req.result.createObjectStore('media', { keyPath: 'id' });
      req.result.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = function () { db = req.result; cb(true); };
    req.onerror = req.onblocked = function () { AdCache.available = false; cb(false); };
  }

  // Runs one IndexedDB transaction. work(store) returns the request whose result we want.
  function withStore(name, mode, work, cb) {
    var result = null;
    try {
      var t = db.transaction(name, mode);
      var req = work(t.objectStore(name));
      if (req) req.onsuccess = function () { result = req.result; };
      t.oncomplete = function () { if (cb) cb(null, result); };
      t.onerror = t.onabort = function () { if (cb) cb(t.error || new Error('storage error')); };
    } catch (e) {
      if (cb) cb(e);
    }
  }

  function listAll(cb) {
    withStore('media', 'readonly', function (s) { return s.getAll(); }, function (err, rows) { cb(err ? [] : rows || []); });
  }

  // How much we may store. cacheMaxMb in config.js wins; otherwise 70% of what the browser allows.
  function budget(cb) {
    if (cfg.cacheMaxMb) { cb(cfg.cacheMaxMb * 1048576); return; }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (e) { cb(e && e.quota ? Math.floor(e.quota * 0.7) : 0); }, function () { cb(0); });
        return;
      }
    } catch (e) {}
    cb(0); // 0 = no known limit
  }

  function download(ad, cb) {
    var x = new XMLHttpRequest();
    var lastPct = -1;
    x.open('GET', API + ad.src, true);
    x.responseType = 'blob';
    x.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.floor((e.loaded * 100) / e.total);
      if (pct !== lastPct && status[ad.id]) { lastPct = pct; status[ad.id].pct = pct; notify(); }
    };
    x.onload = function () {
      // A size mismatch means a cut-off or changed file: never keep it.
      if (x.status === 200 && x.response && x.response.size === ad.sizeBytes) cb(x.response);
      else cb(null);
    };
    x.onerror = x.ontimeout = x.onabort = function () { cb(null); };
    try { x.send(); } catch (e) { cb(null); }
  }

  // Brings the cache in line with the manifest: drop ads that are gone or changed, download missing ones in play order.
  AdCache.sync = function (manifest) {
    if (!db || !manifest || !manifest.ads) return;
    lastManifest = manifest;
    if (busy) { queued = manifest; return; }
    busy = true;
    clearTimeout(retryTimer);
    listAll(function (rows) {
      var byId = {}, want = {}, i, id, stale = [], todo = [], used = 0, failed = 0;
      for (i = 0; i < rows.length; i++) byId[rows[i].id] = rows[i];
      for (i = 0; i < manifest.ads.length; i++) want[manifest.ads[i].id] = manifest.ads[i];

      for (id in byId) {
        if (!want[id] || byId[id].stamp !== stamp(want[id]) || byId[id].size !== want[id].sizeBytes) stale.push(id);
      }
      status = {};
      for (i = 0; i < manifest.ads.length; i++) {
        var ad = manifest.ads[i], rec = byId[ad.id];
        if (rec && stale.indexOf(ad.id) < 0) { status[ad.id] = { state: 'ready' }; used += rec.size; }
        else { status[ad.id] = { state: 'waiting', pct: 0 }; todo.push(ad); }
      }
      notify();

      function finish() {
        busy = false;
        notify();
        if (queued) { var m = queued; queued = null; AdCache.sync(m); return; }
        if (failed) { retryTimer = setTimeout(function () { if (lastManifest) AdCache.sync(lastManifest); }, RETRY_MS); }
      }

      function step(limit) {
        var ad = todo.shift();
        if (!ad) { finish(); return; }
        if (limit && used + ad.sizeBytes > limit) { status[ad.id] = { state: 'nospace' }; notify(); step(limit); return; }
        status[ad.id] = { state: 'downloading', pct: 0 };
        notify();
        download(ad, function (blob) {
          if (!blob) { status[ad.id] = { state: 'error' }; failed++; notify(); step(limit); return; }
          withStore('media', 'readwrite', function (s) {
            return s.put({ id: ad.id, stamp: stamp(ad), size: blob.size, type: ad.mimeType, blob: blob, storedAt: new Date().getTime() });
          }, function (err) {
            if (err) { status[ad.id] = { state: 'nospace' }; } // the browser refused to store it
            else { status[ad.id] = { state: 'ready' }; used += blob.size; }
            notify();
            step(limit);
          });
        });
      }

      function afterDelete() {
        budget(function (limit) {
          try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
          step(limit);
        });
      }

      if (!stale.length) { afterDelete(); return; }
      withStore('media', 'readwrite', function (s) { for (var k = 0; k < stale.length; k++) s.delete(stale[k]); }, afterDelete);
    });
  };

  // Calls back with an object URL for the cached file, or null when it is not cached (play from the network instead).
  AdCache.blobUrl = function (ad, cb) {
    if (!db) { cb(null); return; }
    withStore('media', 'readonly', function (s) { return s.get(ad.id); }, function (err, rec) {
      if (err || !rec || !rec.blob || rec.stamp !== stamp(ad)) { cb(null); return; }
      try { cb(URL.createObjectURL(rec.blob)); } catch (e) { cb(null); }
    });
  };

  // Remember the last ad list so a TV that cannot reach the backend can still start playing what it has.
  AdCache.saveManifest = function (manifest) {
    if (!db) return;
    withStore('meta', 'readwrite', function (s) { return s.put({ key: 'manifest', value: manifest }); });
  };
  AdCache.loadManifest = function (cb) {
    if (!db) { cb(null); return; }
    withStore('meta', 'readonly', function (s) { return s.get('manifest'); }, function (err, row) { cb(err || !row ? null : row.value); });
  };

  AdCache.label = function (ad) {
    if (!AdCache.available) return 'Not available';
    var s = status[ad.id];
    if (!s) return '';
    if (s.state === 'ready') return 'Saved';
    if (s.state === 'downloading') return (s.pct || 0) + '%';
    if (s.state === 'waiting') return 'Waiting';
    if (s.state === 'nospace') return 'No space';
    return 'Will retry';
  };

  AdCache.summary = function (manifest) {
    var ready = 0, bytes = 0, i;
    for (i = 0; i < manifest.ads.length; i++) {
      if (status[manifest.ads[i].id] && status[manifest.ads[i].id].state === 'ready') { ready++; bytes += manifest.ads[i].sizeBytes; }
    }
    return { ready: ready, total: manifest.ads.length, bytes: bytes };
  };

  AdCache.open = open;
  window.AdCache = AdCache;
})();
