(function () {
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Where the backend lives. Empty = same server that served this page. The webOS/Android wrappers set it in config.js.
  var API = (window.TV_CONFIG && window.TV_CONFIG.apiBase) || '';
  var data = null;

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

  function init() {
    var IMAGE_SEC = 60;
    var tbody = $('rows');

    function renderBoard() {
      var s = data.summary, i, j, k;
      $('sub').innerHTML = '';
      $('sub').appendChild(document.createTextNode('Updated ' + fmtDate(data.generatedAt, true)));
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
    function setOnline(v) { online = v; showWifi(); }
    window.addEventListener('online', function () { setOnline(true); checkUpdate(); });
    window.addEventListener('offline', function () { setOnline(false); });
    showWifi();

    // ---- player: each ad in order, then back to the first
    var active = false, inHistory = false, idx = -1, timer = null, watchdog = null, failures = 0, pending = null, autoLeft = 0, autoTimer = null;

    function clearStage() {
      clearTimeout(timer); clearTimeout(watchdog);
      var stage = $('stage'), v = stage.getElementsByTagName('video')[0];
      if (v) { v.onended = v.onerror = v.onplaying = null; try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
      stage.innerHTML = '';
    }
    function fullscreen(on) {
      try {
        var d = document, r = d.documentElement;
        if (on) { (r.requestFullscreen || r.webkitRequestFullscreen || r.mozRequestFullScreen || function () {}).call(r); }
        else if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); }
      } catch (e) {}
    }
    function applyPending() {
      if (!pending) return;
      data = pending; pending = null; window.ADS_MANIFEST = data;
      renderBoard();
      idx = -1;
    }
    function skip() {
      clearTimeout(timer); clearTimeout(watchdog);
      failures++;
      timer = setTimeout(next, failures >= data.ads.length ? 10000 : 1500);
    }
    function next() { go(idx + 1); }
    function go(i) {
      if (!active) return;
      applyPending();
      if (!data.ads.length) { stopPlayer(); return; }
      idx = ((i % data.ads.length) + data.ads.length) % data.ads.length;
      play(data.ads[idx]);
    }
    function play(ad) {
      clearStage();
      $('mute').hidden = true;
      var stage = $('stage');
      if (ad.type === 'image') {
        var img = document.createElement('img');
        img.onload = function () { failures = 0; };
        img.onerror = skip;
        img.src = API + ad.src;
        stage.appendChild(img);
        timer = setTimeout(next, (ad.durationSec || IMAGE_SEC) * 1000);
        return;
      }
      var v = document.createElement('video');
      v.setAttribute('playsinline', '');
      v.onended = next;
      v.onerror = skip;
      v.onplaying = function () { failures = 0; clearTimeout(watchdog); };
      v.src = API + ad.src;
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
    function stopPlayer() {
      if (!active) return;
      active = false;
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
        if (!m || !m.ads || m.revision === data.revision) return;
        pending = m;
        if (!active) { applyPending(); }   // while playing, switch at the next ad boundary
      };
      x.onerror = x.ontimeout = function () { setOnline(false); };
      try { x.send(); } catch (e) {}
    }
    var every = ((data.settings && data.settings.syncIntervalSec) || 300) * 1000;
    setInterval(checkUpdate, every);

    // ---- controls: Start/Enter, X / Back / Esc exits, left/right skip
    $('start').onclick = startPlayer;
    $('exit').onclick = function () { stopPlayer(); };
    document.addEventListener('keydown', function (e) {
      var k = e.keyCode;
      if (active) {
        // Back: Esc, Backspace, Android TV / browser Back, webOS (461) and Tizen (10009) remotes.
        var back = k === 27 || k === 8 || k === 4 || k === 461 || k === 10009 ||
          e.key === 'GoBack' || e.key === 'BrowserBack' || e.key === 'Escape';
        if (back) { e.preventDefault(); stopPlayer(); return; }
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
    window.addEventListener('popstate', function () { if (active) { inHistory = false; stopPlayer(); } });
    $('player-root').onclick = function (e) { if (e.target !== $('exit')) userGesture(); };

    renderBoard();
    window.ADS_PLAYER = { start: startPlayer, stop: stopPlayer };
    if (data.ads.length) {
      autoLeft = 10;
      var label = $('start').firstChild;
      label.nodeValue = 'Start playing (' + autoLeft + ')';
      autoTimer = setInterval(function () {
        autoLeft--;
        if (autoLeft <= 0) { startPlayer(); } else { label.nodeValue = 'Start playing (' + autoLeft + ')'; }
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

  // Load the ad list, then show the table and start the countdown. Retries until the backend answers.
  function boot() {
    loadManifest(function (status, m) {
      if (status === 200 && m && m.ads) {
        data = m;
        window.ADS_MANIFEST = data;
        $('loading').hidden = true;
        $('board').hidden = false;
        init();
        return;
      }
      $('wifi').className = 'wifi ' + (status === 0 ? 'off' : 'on');
      $('loading-text').textContent = status === 0
        ? 'Cannot reach the ad server. Trying again shortly.'
        : ((m && m.error) || 'Loading the ads.');
      setTimeout(boot, 10000);
    });
  }
  boot();
})();
