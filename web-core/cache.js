// Offline media cache. Keeps each ad's file in IndexedDB so the player keeps going when the
// backend or the network disappears. IndexedDB is used (not Service Workers / Cache API) because
// those only work on https, and a TV opens the backend over plain http on the local network.
//
// How an update stays safe ("stage, verify, commit"):
//   1. The new ad list from the backend is only STAGED. Whatever the TV is playing keeps playing.
//   2. Missing or changed files are downloaded and size-checked. Files are stored under "ad id | checksum",
//      so an old version and its replacement can sit side by side. Nothing old is touched.
//   3. Only when every file is safely stored, ONE database transaction swaps in the new ad list and
//      deletes the files nobody needs any more. A failure at any earlier point changes nothing.
// The very first list for an empty cache is the exception: it plays at once (there is nothing else to
// play) and is committed when its files are saved.
//
// Plain ES5 like the rest of web-core. If IndexedDB is missing or blocked, AdCache.available is
// false and everything simply streams from the backend as before.
(function () {
  var cfg = window.TV_CONFIG || {};
  var API = cfg.apiBase || '';
  var RETRY_MS = 60000;
  var MAX_ATTEMPTS = 3;   // after this many failed downloads an ad is allowed to stream instead of blocking the update

  var db = null;
  var busy = false;        // one sync at a time; downloads run one by one so the TV's bandwidth and memory are not swamped
  var queued = null;       // newest manifest that arrived while busy
  var lastManifest = null;
  var retryTimer = null;
  var committed = null;    // { sourceId, sourceName, revision, manifest, committedAt, lastSyncAt } or null
  var staged = null;       // { revision, total, remaining } while an update is being prepared
  var status = {};         // file key -> { state: 'ready' | 'downloading' | 'waiting' | 'nospace' | 'error', pct: n }
  var attempts = {};       // ad id -> failed download attempts since this page opened

  var AdCache = { available: !!window.indexedDB, onChange: null, onPlaylist: null };

  function emit(fn, a) { if (fn) { try { fn(a); } catch (e) {} } }
  function notify() { emit(AdCache.onChange); }

  // The file on Drive "is the same" when its checksum (or modified time) and size match.
  function stamp(ad) { return (ad.md5 || String(ad.modifiedTime)) + ':' + ad.sizeBytes; }
  function key(ad) { return ad.id + '|' + stamp(ad); }
  function sourceId(m) { return (m && m.source && m.source.id) || ''; }

  function open(cb) {
    if (db) { cb(true); return; }
    if (!AdCache.available) { cb(false); return; }
    var req;
    try { req = window.indexedDB.open('tvads', 2); } catch (e) { AdCache.available = false; cb(false); return; }
    req.onupgradeneeded = function () {
      var d = req.result;
      // Version 1 stored files by ad id only. The new layout needs different keys, so start clean (files are re-downloaded once).
      if (d.objectStoreNames.contains('media')) d.deleteObjectStore('media');
      if (d.objectStoreNames.contains('meta')) d.deleteObjectStore('meta');
      d.createObjectStore('media', { keyPath: 'k' });
      d.createObjectStore('meta', { keyPath: 'key' });
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
  function quota(cb) {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (e) { cb(e || {}); }, function () { cb({}); });
        return;
      }
    } catch (e) {}
    cb({});
  }
  function budget(cb) {
    if (cfg.cacheMaxMb) { cb(cfg.cacheMaxMb * 1048576); return; }
    quota(function (e) { cb(e.quota ? Math.floor(e.quota * 0.7) : 0); }); // 0 = no known limit
  }

  function download(ad, cb) {
    var x = new XMLHttpRequest();
    var lastPct = -1;
    x.open('GET', API + ad.src, true);
    x.responseType = 'blob';
    x.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.floor((e.loaded * 100) / e.total);
      var s = status[key(ad)];
      if (pct !== lastPct && s) { lastPct = pct; s.pct = pct; notify(); }
    };
    x.onload = function () {
      // A size mismatch means a cut-off or changed file: never keep it.
      if (x.status === 200 && x.response && x.response.size === ad.sizeBytes) cb(x.response);
      else cb(null);
    };
    x.onerror = x.ontimeout = x.onabort = function () { cb(null); };
    try { x.send(); } catch (e) { cb(null); }
  }

  // The swap. One transaction: record the new ad list as "the" playlist AND delete every file it does not use.
  function commit(manifest, cb) {
    var wanted = {}, i, freed = 0;
    for (i = 0; i < manifest.ads.length; i++) wanted[key(manifest.ads[i])] = true;
    var record = {
      key: 'committed', sourceId: sourceId(manifest), sourceName: (manifest.source && manifest.source.name) || null,
      revision: manifest.revision, manifest: manifest, committedAt: new Date().toISOString(),
      lastSyncAt: committed && committed.lastSyncAt ? committed.lastSyncAt : new Date().toISOString()
    };
    try {
      var t = db.transaction(['media', 'meta'], 'readwrite');
      t.objectStore('meta').put(record);
      var cur = t.objectStore('media').openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c) return;
        if (!wanted[c.value.k]) { freed += c.value.size; c.delete(); }
        c['continue']();
      };
      t.oncomplete = function () { committed = record; cb(null, freed); };
      t.onerror = t.onabort = function () { cb(t.error || new Error('storage error')); };
    } catch (e) { cb(e); }
  }

  // Brings the cache in line with a manifest from the backend (see the header comment).
  AdCache.sync = function (manifest) {
    if (!db || !manifest || !manifest.ads) return;
    lastManifest = manifest;
    if (busy) { queued = manifest; return; }
    busy = true;
    clearTimeout(retryTimer);

    var firstList = !committed;
    if (firstList) emit(AdCache.onPlaylist, manifest);   // nothing saved yet: play this list straight away

    listAll(function (rows) {
      var have = {}, used = 0, todo = [], i, nospace = 0;
      for (i = 0; i < rows.length; i++) { have[rows[i].k] = rows[i]; used += rows[i].size; }
      for (i = 0; i < manifest.ads.length; i++) {
        var ad = manifest.ads[i], k = key(ad);
        if (have[k] && have[k].size === ad.sizeBytes) { status[k] = { state: 'ready' }; }
        else { status[k] = { state: 'waiting', pct: 0 }; todo.push(ad); }
      }
      var isNew = !committed || committed.revision !== manifest.revision || committed.sourceId !== sourceId(manifest);
      staged = isNew ? { revision: manifest.revision, total: manifest.ads.length, remaining: todo.length } : null;
      notify();

      function settle() {
        busy = false;
        // Which ads are still missing, and are they a reason to wait? A failing download blocks the swap for a few tries;
        // an ad that does not fit in storage never blocks it (it streams while online).
        var blocking = 0, j;
        for (j = 0; j < manifest.ads.length; j++) {
          var s = status[key(manifest.ads[j])];
          if (s && s.state === 'error' && (attempts[manifest.ads[j].id] || 0) < MAX_ATTEMPTS) blocking++;
        }
        if (queued) { var m = queued; queued = null; AdCache.sync(m); return; }
        if (blocking) {
          notify();
          retryTimer = setTimeout(function () { if (lastManifest) AdCache.sync(lastManifest); }, RETRY_MS);
          return;
        }
        if (!isNew) { if (nospace || anyError(manifest)) scheduleRetry(); notify(); return; }
        busy = true;   // hold the lock while committing
        commit(manifest, function (err, freed) {
          busy = false;
          if (err) { notify(); scheduleRetry(); return; }
          staged = null;
          notify();
          emit(AdCache.onPlaylist, manifest);
          if (queued) { var q = queued; queued = null; AdCache.sync(q); return; }
          // Space was just freed: ads that did not fit before can be saved now.
          if (nospace && freed > 0) { AdCache.sync(manifest); return; }
          if (anyError(manifest)) scheduleRetry();
        });
      }

      function anyError(m) {
        for (var j = 0; j < m.ads.length; j++) { var s = status[key(m.ads[j])]; if (s && s.state === 'error') return true; }
        return false;
      }
      function scheduleRetry() {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(function () { if (lastManifest) AdCache.sync(lastManifest); }, RETRY_MS);
      }

      function step(limit) {
        var ad = todo.shift();
        if (!ad) { settle(); return; }
        var k = key(ad);
        if (limit && used + ad.sizeBytes > limit) { status[k] = { state: 'nospace' }; nospace++; refresh(); notify(); step(limit); return; }
        status[k] = { state: 'downloading', pct: 0 };
        notify();
        download(ad, function (blob) {
          if (!blob) {
            status[k] = { state: 'error' };
            attempts[ad.id] = (attempts[ad.id] || 0) + 1;
            refresh(); notify(); step(limit); return;
          }
          withStore('media', 'readwrite', function (s) {
            return s.put({ k: k, id: ad.id, stamp: stamp(ad), size: blob.size, type: ad.mimeType, blob: blob, storedAt: new Date().getTime() });
          }, function (err) {
            if (err) { status[k] = { state: 'nospace' }; nospace++; }     // the browser refused to store it
            else { status[k] = { state: 'ready' }; used += blob.size; attempts[ad.id] = 0; }
            refresh(); notify(); step(limit);
          });
        });
      }
      function refresh() {
        if (!staged) return;
        var left = 0, j;
        for (j = 0; j < manifest.ads.length; j++) { if (!status[key(manifest.ads[j])] || status[key(manifest.ads[j])].state !== 'ready') left++; }
        staged.remaining = left;
      }

      budget(function (limit) {
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
        step(limit);
      });
    });
  };

  // The saved playlist (and when it was saved), or null. Also checks which of its files are really still there.
  AdCache.loadCommitted = function (cb) {
    if (!db) { cb(null); return; }
    withStore('meta', 'readonly', function (s) { return s.get('committed'); }, function (err, row) {
      if (err || !row) { cb(null); return; }
      committed = row;
      withStore('media', 'readonly', function (s) { return s.getAllKeys(); }, function (err2, keys) {
        var present = {}, i;
        for (i = 0; keys && i < keys.length; i++) present[keys[i]] = true;
        for (i = 0; i < row.manifest.ads.length; i++) {
          var k = key(row.manifest.ads[i]);
          status[k] = present[k] ? { state: 'ready' } : { state: 'waiting', pct: 0 };
        }
        cb(row);
      });
    });
  };

  // Calls back with an object URL for the saved file, or null when it is not saved (play from the network instead).
  AdCache.blobUrl = function (ad, cb) {
    if (!db) { cb(null); return; }
    withStore('media', 'readonly', function (s) { return s.get(key(ad)); }, function (err, rec) {
      if (err || !rec || !rec.blob) { cb(null); return; }
      try { cb(URL.createObjectURL(rec.blob)); } catch (e) { cb(null); }
    });
  };

  // Remember when the backend last answered (shown as "Last sync" while offline).
  AdCache.touchSync = function (iso) {
    if (!db || !committed) return;
    committed.lastSyncAt = iso;
    withStore('meta', 'readwrite', function (s) { return s.put(committed); });
  };

  AdCache.label = function (ad) {
    if (!AdCache.available) return 'Not available';
    var s = status[key(ad)];
    if (!s) return '';
    if (s.state === 'ready') return 'Saved';
    if (s.state === 'downloading') return (s.pct || 0) + '%';
    if (s.state === 'waiting') return 'Waiting';
    if (s.state === 'nospace') return 'No space';
    return 'Will retry';
  };

  AdCache.summary = function (manifest) {
    var ready = 0, bytes = 0, nospace = 0, i;
    for (i = 0; i < manifest.ads.length; i++) {
      var s = status[key(manifest.ads[i])];
      if (s && s.state === 'ready') { ready++; bytes += manifest.ads[i].sizeBytes; }
      else if (s && s.state === 'nospace') nospace++;
    }
    return { ready: ready, total: manifest.ads.length, bytes: bytes, nospace: nospace };
  };

  AdCache.hasReady = function (manifest) { return AdCache.summary(manifest).ready > 0; };

  // An update that is being prepared in the background: { total, remaining } or null.
  AdCache.pending = function () { return staged ? { total: staged.total, remaining: staged.remaining } : null; };

  // Numbers for the details screen.
  AdCache.info = function (cb) {
    quota(function (e) {
      cb({
        available: AdCache.available,
        quota: cfg.cacheMaxMb ? cfg.cacheMaxMb * 1048576 : (e.quota || 0),
        sourceName: committed ? committed.sourceName : null,
        committedAt: committed ? committed.committedAt : null,
        lastSyncAt: committed ? committed.lastSyncAt : null
      });
    });
  };

  AdCache.open = open;
  window.AdCache = AdCache;
})();
