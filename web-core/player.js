(function () {
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Where the backend lives. Empty = same server that served this page. The webOS/Android wrappers set it in config.js.
  var API = (window.TV_CONFIG && window.TV_CONFIG.apiBase) || '';
  var data = null;
  // Offline media cache (cache.js). If that file is missing, a do-nothing stand-in makes the player stream from the backend.
  var cache = window.AdCache || {
    available: false,
    open: function (cb) { cb(false); }, sync: function () {}, loadCommitted: function (cb) { cb(null); }, touchSync: function () {},
    blobUrl: function (ad, cb) { cb(null); }, label: function () { return ''; }, hasReady: function () { return true; },
    summary: function () { return { ready: 0, total: 0, bytes: 0, nospace: 0 }; }, pending: function () { return null; },
    info: function (cb) { cb({ available: false, quota: 0 }); }
  };

  // Small settings kept on the device (which screen this is, whether it was playing). Works without storage too.
  function keep(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value);
    } catch (e) {}
    return null;
  }
  function screenId() {
    var id = keep('tvads.deviceId');
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = 'tv-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) + new Date().getTime().toString(36);
      keep('tvads.deviceId', id);
    }
    return id;
  }

  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.appendChild(document.createTextNode(String(text)));
    return e;
  }
  function fmtDate(iso, withYear) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (withYear ? ' ' + d.getFullYear() : '') +
      ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDuration(sec) {
    var s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
  }
  function fmtSize(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(b >= 104857600 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  }

  function init(fromCache, live) {
    var IMAGE_SEC = 60;
    var tbody = $('rows');

    var cacheCells = {};
    var health = null, extra = { quota: 0, lastSyncAt: null }, extraAt = 0, loadedVersion = null, reloadWanted = false;
    function refreshFacts() {
      var sum = cache.summary(data), parts = [], up = cache.pending();
      $('f-folder').textContent = (data.source && data.source.name) || 'Drive folder';
      $('f-saved').textContent = cache.available
        ? sum.ready + ' of ' + sum.total + ' ads, ' + fmtSize(sum.bytes) + (extra.quota ? ' (about ' + fmtSize(extra.quota) + ' available)' : '')
        : 'Not available in this browser';
      $('f-conn').textContent = online ? 'Online' : 'Offline';
      var last = (health && health.lastSuccessAt) || extra.lastSyncAt;
      $('f-last').textContent = last ? fmtDate(last, true) : 'Not yet';
      if (up && up.remaining) parts.push('Updating to a new version: ' + (up.total - up.remaining) + ' of ' + up.total + ' files saved. The current ads keep playing until it is ready.');
      if (sum.nospace) parts.push(sum.nospace + (sum.nospace === 1 ? ' ad does' : ' ads do') + ' not fit in the available storage and will play from the network while online.');
      if (health && health.syncOk === false) parts.push('The server could not reach Google Drive recently. Saved ads keep playing.');
      $('cache-note').textContent = parts.join(' ');
    }
    function refreshCache() {
      var i;
      for (i = 0; i < data.ads.length; i++) {
        var c = cacheCells[data.ads[i].id];
        if (c) c.textContent = cache.label(data.ads[i]);
      }
      refreshFacts();
      var t = new Date().getTime();
      if (t - extraAt > 5000) {   // the storage estimate is not free: look at most every 5 seconds
        extraAt = t;
        cache.info(function (i2) { extra = { quota: i2.quota, lastSyncAt: i2.lastSyncAt }; refreshFacts(); });
      }
    }
    function fetchHealth() {
      var x = new XMLHttpRequest();
      x.open('GET', API + '/api/health', true);
      x.timeout = 10000;
      x.onload = function () {
        try { health = JSON.parse(x.responseText); } catch (e) {}
        refreshFacts();
        // The backend serves a newer page (web-core was updated): reload between two ads. The app has its page built in, so it never does this.
        if (health && health.webVersion && !window.TVNative) {
          if (!loadedVersion) loadedVersion = health.webVersion;
          else if (health.webVersion !== loadedVersion) { reloadWanted = true; if (!active) reloadSafely(); }
        }
      };
      try { x.send(); } catch (e) {}
    }
    // Only reload when the new page can really be fetched, so a backend that just went down cannot leave a blank screen.
    function reloadSafely() {
      var x = new XMLHttpRequest();
      x.open('GET', API + '/tv/index.html?t=' + new Date().getTime(), true);
      x.timeout = 8000;
      x.onload = function () { if (x.status === 200) window.location.reload(); };
      try { x.send(); } catch (e) {}
    }
    // Tells the backend which screen this is and how it is doing (shown on the admin page). Nothing here is secret.
    function sendHeartbeat() {
      var sum = cache.summary(data), x = new XMLHttpRequest();
      x.open('POST', API + '/tv/heartbeat', true);
      x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');   // a plain request: no cross-origin pre-check needed
      x.timeout = 8000;
      try {
        x.send(JSON.stringify({
          id: screenId(), name: (window.TV_CONFIG && window.TV_CONFIG.screenName) || null,
          kind: window.TVNative ? 'android' : 'browser', version: health && health.webVersion || null,
          online: online, playing: active && data.ads[idx] ? data.ads[idx].fileName : null,
          revision: data.revision, folder: data.source && data.source.name || null,
          adsSaved: sum.ready, adsTotal: sum.total, cacheBytes: sum.bytes, quotaBytes: extra.quota
        }));
      } catch (e) {}
    }
    function renderBoard() {
      var s = data.summary, i, j, k;
      $('sub').innerHTML = '';
      $('sub').appendChild(document.createTextNode('Updated ' + fmtDate(data.generatedAt, true)));
      cacheCells = {};
      $('stats').innerHTML = '';
      var loop = fmtDuration(s.loopSec) + (s.unknownDurations ? '+' : '');
      var stats = [['Ads', s.totalAds], ['Videos', s.videos], ['Images', s.images], ['One loop', loop], ['Total size', fmtSize(s.totalBytes)]];
      for (i = 0; i < stats.length; i++) {
        var box = el('div', 'stat');
        box.appendChild(el('dt', null, stats[i][0]));
        box.appendChild(el('dd', null, stats[i][1]));
        $('stats').appendChild(box);
      }
      $('table').hidden = !data.ads.length;
      $('empty').hidden = !!data.ads.length;
      $('start').hidden = !data.ads.length;
      tbody.innerHTML = '';
      for (j = 0; j < data.ads.length; j++) {
        var ad = data.ads[j], tr = el('tr');
        tr.appendChild(el('td', 'c-order', ad.order));
        tr.appendChild(el('td', 'c-ad', ad.adName));
        tr.appendChild(el('td', 'c-file', ad.fileName));
        var kind = el('td', 'c-type');
        kind.appendChild(el('span', 'kind kind-' + ad.type, ad.type === 'video' ? 'Video' : 'Image'));
        tr.appendChild(kind);
        tr.appendChild(ad.durationSec === null
          ? el('td', 'c-len num muted', 'Full video')
          : el('td', 'c-len num', fmtDuration(ad.durationSec)));
        tr.appendChild(el('td', 'c-size num', fmtSize(ad.sizeBytes)));
        tr.appendChild(el('td', 'c-added num muted', fmtDate(ad.createdTime, false)));
        cacheCells[ad.id] = el('td', 'c-cache num muted', cache.label(ad));
        tr.appendChild(cacheCells[ad.id]);
        tbody.appendChild(tr);
      }
      $('skipped-list').innerHTML = '';
      $('skipped').hidden = !(data.skipped && data.skipped.length);
      for (k = 0; data.skipped && k < data.skipped.length; k++) {
        var sk = data.skipped[k];
        $('skipped-list').appendChild(el('li', null, (sk.adName ? sk.adName + '/' : '') + sk.fileName + ': ' + sk.reason));
      }
    }

    // ---- connectivity icon: green online, red offline
    var online = navigator.onLine !== false;
    function showWifi() { $('wifi').className = 'wifi ' + (online ? 'on' : 'off'); $('wifi').title = online ? 'Online' : 'Offline'; }
    function setOnline(v) { var changed = v !== online; online = v; showWifi(); refreshFacts(); if (changed && typeof sendHeartbeat === 'function' && data) sendHeartbeat(); }
    window.addEventListener('online', function () { setOnline(true); checkUpdate(); });
    window.addEventListener('offline', function () { setOnline(false); });
    showWifi();

    // ---- player: each ad in order, then back to the first
    var playSeq = 0, curUrl = null, active = false, inHistory = false, idx = -1, timer = null, watchdog = null, failures = 0, pending = null, autoLeft = 0, autoTimer = null;

    // Removes whatever is on screen (and frees the saved-file URL it used).
    function removeMedia() {
      var stage = $('stage'), v = stage.getElementsByTagName('video')[0];
      if (v) { v.onended = v.onerror = v.onplaying = null; try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
      stage.innerHTML = '';
      if (curUrl) { try { URL.revokeObjectURL(curUrl); } catch (e) {} curUrl = null; }
    }
    function clearStage() {
      playSeq++;
      clearTimeout(timer); clearTimeout(watchdog);
      removeMedia();
    }
    function fullscreen(on) {
      try {
        var d = document, r = d.documentElement;
        if (on) {
          var req = r.requestFullscreen || r.webkitRequestFullscreen || r.mozRequestFullScreen;
          var p = req && req.call(r);
          if (p && p.catch) p.catch(function () {});   // refused (no key press yet, or inside an app WebView): not an error
        }
        else if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); }
      } catch (e) {}
    }
    // Switches to the newest ready ad list. Called between two ads (or at once when nothing is playing).
    function applyPending() {
      if (!pending) return;
      data = pending; pending = null; window.ADS_MANIFEST = data;
      renderBoard();
      refreshFacts();
      idx = -1;
      if (!active && keep('tvads.autoplay') === '1' && data.ads.length) startPlayer();   // it was playing before the list was empty
    }
    function skip() {
      clearTimeout(timer); clearTimeout(watchdog);
      failures++;
      timer = setTimeout(next, failures >= data.ads.length ? 10000 : 1500);
    }
    function next() { go(idx + 1); }
    function go(i) {
      if (!active) return;
      if (reloadWanted) { reloadSafely(); }   // a new page is waiting: reload (the player resumes by itself)
      applyPending();
      if (!data.ads.length) { stopPlayer(); return; }
      idx = ((i % data.ads.length) + data.ads.length) % data.ads.length;
      play(data.ads[idx]);
    }
    function play(ad) {
      playSeq++;
      clearTimeout(timer); clearTimeout(watchdog);
      $('mute').hidden = true;
      var seq = playSeq;
      var old = $('stage').getElementsByTagName('video')[0];
      if (old) { try { old.pause(); } catch (e) {} }   // skipped mid-video: stop its sound, keep the picture until the next ad is ready
      // Prefer the saved copy: it plays the same with or without the network.
      cache.blobUrl(ad, function (url) {
        if (seq !== playSeq) { if (url) { try { URL.revokeObjectURL(url); } catch (e) {} } return; }   // moved on meanwhile
        removeMedia();
        curUrl = url;
        show(ad, url || API + ad.src);
      });
    }
    function show(ad, src) {
      var stage = $('stage');
      if (ad.type === 'image') {
        var img = document.createElement('img');
        img.onload = function () { failures = 0; };
        img.onerror = skip;
        img.src = src;
        stage.appendChild(img);
        timer = setTimeout(next, (ad.durationSec || IMAGE_SEC) * 1000);
        return;
      }
      var v = document.createElement('video');
      v.setAttribute('playsinline', '');
      v.onended = next;
      v.onerror = skip;
      v.onplaying = function () { failures = 0; clearTimeout(watchdog); };
      v.src = src;
      stage.appendChild(v);
      watchdog = setTimeout(skip, 30000);
      var p = v.play();
      if (p && p.catch) {
        p.catch(function () {
          // Autoplay with sound can be blocked before the first key press: retry muted and show the
          // small speaker icon. Pressing OK (or any key) on the remote turns the sound on.
          v.muted = true;
          $('mute').hidden = false;
          var q = v.play();
          if (q && q.catch) q.catch(function () {});
        });
      }
    }
    function stopAuto() { clearInterval(autoTimer); autoTimer = null; $('start').firstChild.nodeValue = 'Start playing'; }
    function startPlayer() {
      if (!data.ads.length) return;
      stopAuto();
      active = true; failures = 0; idx = -1;
      keep('tvads.autoplay', '1');   // after a restart or an update the TV goes straight back to playing
      $('player-root').hidden = false;
      document.body.style.overflow = 'hidden';
      fullscreen(true);
      // No button keeps focus while playing, so pressing OK on the remote cannot press the X by accident.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      try { history.pushState({ adPlayer: true }, ''); inHistory = true; } catch (e) {}
      next();
    }
    function userGesture() {
      // A key press or click is the browser's permission to go fullscreen and to play with sound.
      var d = document;
      if (!(d.fullscreenElement || d.webkitFullscreenElement)) fullscreen(true);
      var v = $('stage').getElementsByTagName('video')[0];
      if (v && v.muted) { v.muted = false; var q = v.play(); if (q && q.catch) q.catch(function () {}); }
      $('mute').hidden = true;
    }
    // byUser: someone chose to leave the player (X, Back); then it stays off after a restart. Without it (for example an empty
    // list) the TV still resumes later.
    function stopPlayer(byUser) {
      if (!active) return;
      active = false;
      if (byUser === true) keep('tvads.autoplay', '0');
      if (inHistory) { inHistory = false; try { history.back(); } catch (e) {} }
      clearStage();
      $('player-root').hidden = true;
      document.body.style.overflow = '';
      fullscreen(false);
      $('start').focus();
    }

    // ---- pick up new revisions published by the backend (every sync interval)
    function checkUpdate() {
      var x = new XMLHttpRequest();
      x.open('GET', API + '/tv/ads.json?t=' + new Date().getTime(), true);
      x.timeout = 20000;
      x.onload = function () {
        if (x.status !== 200) return;
        setOnline(true);
        var m = null;
        try { m = JSON.parse(x.responseText); } catch (e) { return; }
        if (!m || !m.ads) return;
        cache.touchSync(new Date().toISOString());
        fetchHealth();
        if (!cache.available) {   // no saving possible: use the new list directly, as before
          if (m.revision !== data.revision) { pending = m; if (!active) applyPending(); }
          return;
        }
        cache.sync(m);   // download what is new first; the cache hands the list over when it is safe to switch
      };
      x.onerror = x.ontimeout = function () { setOnline(false); };
      try { x.send(); } catch (e) {}
    }
    var every = ((data.settings && data.settings.syncIntervalSec) || 300) * 1000;
    setInterval(checkUpdate, every);
    // While the backend cannot be reached, look again every 30 seconds so recovery is quick.
    setInterval(function () { if (!online) checkUpdate(); }, 30000);

    // ---- controls: Start/Enter, X / Back / Esc exits, left/right skip
    $('start').onclick = startPlayer;
    $('exit').onclick = function () { stopPlayer(true); };
    document.addEventListener('keydown', function (e) {
      var k = e.keyCode;
      if (active) {
        // Back: Esc, Backspace, Android TV / browser Back, webOS (461) and Tizen (10009) remotes.
        var back = k === 27 || k === 8 || k === 4 || k === 461 || k === 10009 ||
          e.key === 'GoBack' || e.key === 'BrowserBack' || e.key === 'Escape';
        if (back) { e.preventDefault(); stopPlayer(true); return; }
        if (k === 40) { e.preventDefault(); $('exit').focus(); return; }          // Down: reach the X
        if (k === 38) { e.preventDefault(); $('exit').blur(); return; }
        if (k === 13 && document.activeElement === $('exit')) return;             // OK on the X exits
        userGesture();
        if (k === 39) { go(idx + 1); }
        else if (k === 37) { go(idx - 1); }
        else if (k === 13) { e.preventDefault(); }
      } else if (autoTimer) { stopAuto(); }
    });
    // The Back button of the browser/remote returns from the player to the table.
    window.addEventListener('popstate', function () { if (active) { inHistory = false; stopPlayer(true); } });
    $('player-root').onclick = function (e) { if (e.target !== $('exit')) userGesture(); };

    $('change-folder').href = API + '/';
    // Inside the Android TV app a native bridge exists: the Back key is offered to the player first, and the
    // server address of the app can be changed from here.
    window.TV_NATIVE_BACK = function () { if (active) { stopPlayer(true); return true; } return false; };
    if (window.TVNative && window.TVNative.changeServer) {
      $('change-server').hidden = false;
      $('change-server').onclick = function () { window.TVNative.changeServer(); };
    }
    $('sync-now').onclick = function () {
      var b = $('sync-now'), x = new XMLHttpRequest();
      b.disabled = true; b.firstChild.nodeValue = 'Syncing';
      function done() { b.disabled = false; b.firstChild.nodeValue = 'Sync now'; checkUpdate(); }
      x.open('POST', API + '/tv/sync', true);
      x.timeout = 120000;
      x.onload = x.onerror = x.ontimeout = done;
      try { x.send(); } catch (e) { done(); }
    };

    renderBoard();
    cache.onChange = refreshCache;
    // The cache says when a complete, safe-to-play ad list is ready (or when an empty cache gets its first list).
    cache.onPlaylist = function (m) {
      if (m.revision === data.revision && (m.source && m.source.id) === (data.source && data.source.id)) return;
      pending = m;
      if (!active) applyPending();
    };
    if (fromCache) { online = false; showWifi(); }
    cache.sync(live || data);
    refreshCache();
    fetchHealth();
    sendHeartbeat();
    setInterval(sendHeartbeat, 60000);
    window.ADS_PLAYER = { start: startPlayer, stop: stopPlayer };
    if (data.ads.length && keep('tvads.autoplay') === '1') {
      startPlayer();   // it was playing when it stopped (power cut, restart, update): carry on without anyone pressing anything
    } else if (data.ads.length) {
      // The countdown ends in playback. With an empty cache it also waits (up to 30 seconds longer) until the first
      // ad is saved, so the TV does not start by streaming everything.
      autoLeft = 10;
      var extraWait = 0;
      var label = $('start').firstChild;
      label.nodeValue = 'Start playing (' + autoLeft + ')';
      autoTimer = setInterval(function () {
        autoLeft--;
        if (autoLeft > 0) { label.nodeValue = 'Start playing (' + autoLeft + ')'; return; }
        if (cache.available && !cache.hasReady(data) && extraWait < 30) { extraWait++; label.nodeValue = 'Saving the first ad'; return; }
        startPlayer();
      }, 1000);
      $('start').focus();
    }
  }

  function loadManifest(done) {
    var x = new XMLHttpRequest();
    x.open('GET', API + '/tv/ads.json?t=' + new Date().getTime(), true);
    x.timeout = 20000;
    x.onload = function () {
      var m = null;
      try { m = JSON.parse(x.responseText); } catch (e) {}
      done(x.status, m);
    };
    x.onerror = x.ontimeout = function () { done(0, null); };
    try { x.send(); } catch (e) { done(0, null); }
  }

  function showBoard() {
    $('loading').hidden = true;
    $('board').hidden = false;
  }

  // Start-up. The ads that were saved on this device ("the committed list") are what plays. The list from the backend is
  // only staged: the cache downloads what is new and hands it over when everything is safely stored.
  //  - backend answers, nothing saved yet: play the backend's list and save it as we go
  //  - backend answers, something saved:    keep playing the saved list, stage the new one in the background
  //  - backend does not answer, saved list: play from the saved files (offline start)
  function boot() {
    cache.open(function () {
      cache.loadCommitted(function (saved) {
        loadManifest(function (status, m) {
          var live = status === 200 && m && m.ads ? m : null;
          var keep = saved && saved.manifest && saved.manifest.ads && saved.manifest.ads.length ? saved.manifest : null;
          if (live || keep) {
            data = (cache.available && keep) ? keep : live;
            if (!data) data = keep;
            window.ADS_MANIFEST = data;
            showBoard();
            init(!live, live);
            return;
          }
          $('wifi').className = 'wifi ' + (status === 0 ? 'off' : 'on');
          $('loading-text').textContent = status === 0
            ? 'Cannot reach the ad server. Trying again shortly.'
            : ((m && m.error) || 'Loading the ads.');
          setTimeout(boot, 10000);
        });
      });
    });
  }
  boot();
})();
