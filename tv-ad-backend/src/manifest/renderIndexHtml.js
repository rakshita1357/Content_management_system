// Builds index.html: the first screen on the TV. A run-order table rendered from the JSON embedded
// in the page itself, so index.html works as a single downloaded file (and offline).
//
// Compatibility: old LG webOS versions ship old Chromium, so the page script is plain ES5
// and the CSS avoids custom properties, grid and clamp().

// JSON inside <script> must not be able to close the tag (a file named "</script>.mp4" would).
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const escapeAttr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));

const CSS = `
[hidden]{display:none!important}
*{box-sizing:border-box}
html{font-size:1.15vw;background:#0f2233}
body{margin:0;min-height:100vh;background:#0f2233;color:#e8eef3;
  font-family:"Barlow","Roboto","Helvetica Neue",Arial,sans-serif;line-height:1.35;
  -webkit-font-smoothing:antialiased}
.board{padding:4.5vh 4.5vw 4vh}
.head{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-flex-wrap:wrap;flex-wrap:wrap;
  -webkit-box-align:end;-webkit-align-items:flex-end;align-items:flex-end;
  -webkit-box-pack:justify;-webkit-justify-content:space-between;justify-content:space-between;
  padding-bottom:1.2rem;border-bottom:0.18rem solid #f5b841}
h1{margin:0;font-family:"Barlow Condensed","Roboto Condensed","Arial Narrow",Arial,sans-serif;
  font-weight:700;font-size:3.4rem;line-height:1;letter-spacing:0.01em}
.sub{margin:0.5rem 0 0;color:#93a8ba;font-size:1.05rem}
.stats{display:-webkit-box;display:-webkit-flex;display:flex;margin:0}
.stat{margin-left:2.6rem;text-align:right}
.stat dt{color:#93a8ba;font-size:0.95rem}
.stat dd{white-space:nowrap;margin:0.1rem 0 0;font-family:"Barlow Condensed","Roboto Condensed","Arial Narrow",Arial,sans-serif;
  font-weight:600;font-size:2.1rem;line-height:1.05}
table{width:100%;border-collapse:collapse;margin-top:0.6rem}
th{text-align:left;font-weight:500;color:#93a8ba;font-size:0.95rem;padding:0.9rem 1rem 0.6rem;
  border-bottom:1px solid #24425c}
td{padding:0.85rem 1rem;border-bottom:1px solid #1d3850;font-size:1.15rem;vertical-align:middle}
tbody tr:nth-child(even) td{background:#122840}
.c-order{width:5.5rem}
td.c-order{font-family:"Barlow Condensed","Roboto Condensed","Arial Narrow",Arial,sans-serif;
  font-weight:700;font-size:2.2rem;line-height:1;color:#f5b841}
td.c-ad{font-weight:600;font-size:1.3rem}
td.c-file{color:#b8c7d4;word-break:break-all}
.num{text-align:right;white-space:nowrap}
.kind{display:inline-block;padding:0.15rem 0.6rem;border-radius:0.3rem;font-size:0.95rem;font-weight:600}
.kind-video{color:#0f2233;background:#7fd6cf}
.kind-image{color:#0f2233;background:#c8bdf5}
.muted{color:#93a8ba}
.empty{margin:3rem 0;font-size:1.5rem;color:#b8c7d4;max-width:45rem}
.skipped{margin-top:2.2rem;padding:1rem 1.2rem;border-left:0.3rem solid #e0795a;background:#162c42}
.skipped h2{margin:0 0 0.4rem;font-size:1.2rem;font-weight:600}
.skipped ul{margin:0;padding-left:1.2rem;color:#b8c7d4;font-size:1rem}
.skipped li{margin:0.2rem 0}
.error{margin:4rem 0;font-size:1.6rem;color:#e0795a}
#start{margin-top:1.6rem;padding:0.8rem 1.8rem;font-size:1.3rem;font-weight:600;color:#0f2233;background:#f5b841;
  border:0.2rem solid #f5b841;border-radius:0.4rem;cursor:pointer;font-family:inherit}
#start:focus{outline:0.25rem solid #fff}
.wifi{position:fixed;left:1.2rem;bottom:1rem;width:2.2rem;height:2.2rem;z-index:30;color:#3ddc84}
.wifi.off{color:#ff4d4d}
.wifi svg{width:100%;height:100%;display:block}
#player-root{position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:20;cursor:none}
#stage{position:absolute;top:0;left:0;width:100%;height:100%}
#stage img,#stage video{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;background:#000}
#exit{position:absolute;right:1rem;bottom:1rem;width:2.6rem;height:2.6rem;line-height:2.2rem;font-size:1.8rem;
  color:#fff;background:rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.35);border-radius:50%;
  cursor:pointer;opacity:0.6;padding:0;font-family:inherit}
#exit:focus{opacity:1;outline:0.2rem solid #fff}
@media (max-width:1100px){html{font-size:15px}.c-file,.c-added{display:none}}
@media (max-width:640px){.c-size{display:none}.stats{width:100%;margin-top:1rem;-webkit-flex-wrap:wrap;flex-wrap:wrap}
  .stat{margin:0 1.6rem 0.6rem 0;text-align:left}h1{font-size:2.4rem}}
`;

// ES5 only: no arrow functions, let/const, template literals or String.prototype.padStart.
const SCRIPT = `
(function () {
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var data = null;
  try { data = JSON.parse(document.getElementById('ads-data').textContent); } catch (e) {}
  window.ADS_MANIFEST = data;

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

  if (!data || !data.ads) {
    var table = $('table');
    table.parentNode.replaceChild(
      el('p', 'error', 'The ad list could not be read. The backend rebuilds it on the next sync.'), table);
    return;
  }

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
  var active = false, idx = -1, timer = null, watchdog = null, failures = 0, pending = null, autoLeft = 0, autoTimer = null;

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
    var stage = $('stage');
    if (ad.type === 'image') {
      var img = document.createElement('img');
      img.onload = function () { failures = 0; };
      img.onerror = skip;
      img.src = ad.src;
      stage.appendChild(img);
      timer = setTimeout(next, (ad.durationSec || IMAGE_SEC) * 1000);
      return;
    }
    var v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.onended = next;
    v.onerror = skip;
    v.onplaying = function () { failures = 0; clearTimeout(watchdog); };
    v.src = ad.src;
    stage.appendChild(v);
    watchdog = setTimeout(skip, 30000);
    var p = v.play();
    if (p && p.catch) {
      p.catch(function () {
        // Autoplay with sound can be blocked before the first key press: retry muted.
        v.muted = true;
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
    $('exit').focus();
    next();
  }
  function stopPlayer() {
    active = false;
    clearStage();
    $('player-root').hidden = true;
    document.body.style.overflow = '';
    fullscreen(false);
    $('start').focus();
  }

  // ---- pick up new revisions published by the backend (every sync interval)
  function checkUpdate() {
    var x = new XMLHttpRequest();
    x.open('GET', '/tv/ads.json?t=' + new Date().getTime(), true);
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
      if (k === 27 || k === 8 || k === 461 || k === 10009) { e.preventDefault(); stopPlayer(); }
      else if (k === 39) { go(idx + 1); }
      else if (k === 37) { go(idx - 1); }
    } else if (autoTimer) { stopAuto(); }
  });

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
})();
`;

import { publicManifest } from './buildManifest.js';

export function renderIndexHtml(manifest) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ads-revision" content="${escapeAttr(manifest.revision)}">
<title>Ad run order</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700&display=swap">
<style>${CSS}</style>
</head>
<body>
<main class="board">
  <header class="head">
    <div>
      <h1>Ad run order</h1>
      <p class="sub" id="sub"></p>
    </div>
    <dl class="stats" id="stats"></dl>
  </header>
  <table id="table">
    <thead>
      <tr>
        <th class="c-order">#</th><th class="c-ad">Ad</th><th class="c-file">File</th><th class="c-type">Type</th>
        <th class="c-len num">On screen</th><th class="c-size num">Size</th><th class="c-added num">Added</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <button id="start" type="button" hidden>Start playing</button>
  <p class="empty" id="empty" hidden>No ads yet. Put an MP4, JPG or PNG inside a subfolder of the Drive folder and it appears here after the next sync.</p>
  <section class="skipped" id="skipped" hidden>
    <h2>Found in Drive but not playing</h2>
    <ul id="skipped-list"></ul>
  </section>
</main>
<div id="player-root" hidden>
  <div id="stage"></div>
  <button id="exit" type="button" aria-label="Exit player">&times;</button>
</div>
<div class="wifi on" id="wifi"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 18.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM12 12c-2.3 0-4.4.9-6 2.4l1.6 1.7A6.7 6.7 0 0 1 12 14.3c1.8 0 3.4.7 4.4 1.8l1.6-1.7A9.1 9.1 0 0 0 12 12zm0-6.5c-3.8 0-7.2 1.5-9.7 3.9l1.6 1.7A11.4 11.4 0 0 1 12 7.8c3.1 0 5.9 1.2 8.1 3.3l1.6-1.7A13.7 13.7 0 0 0 12 5.5z"/></svg></div>
<script type="application/json" id="ads-data">${embedJson(publicManifest(manifest))}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
