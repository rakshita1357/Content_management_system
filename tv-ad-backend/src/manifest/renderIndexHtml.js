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
  window.ADS_MANIFEST = data; // Phase 3: the player reads this.

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

  var s = data.summary;
  $('sub').appendChild(document.createTextNode('Updated ' + fmtDate(data.generatedAt, true)));

  var loop = fmtDuration(s.loopSec) + (s.unknownDurations ? '+' : '');
  var stats = [['Ads', s.totalAds], ['Videos', s.videos], ['Images', s.images], ['One loop', loop], ['Total size', fmtSize(s.totalBytes)]];
  for (var i = 0; i < stats.length; i++) {
    var box = el('div', 'stat');
    box.appendChild(el('dt', null, stats[i][0]));
    box.appendChild(el('dd', null, stats[i][1]));
    $('stats').appendChild(box);
  }

  if (!data.ads.length) {
    $('table').hidden = true;
    $('empty').hidden = false;
  }

  var tbody = $('rows');
  for (var j = 0; j < data.ads.length; j++) {
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

  if (data.skipped && data.skipped.length) {
    $('skipped').hidden = false;
    for (var k = 0; k < data.skipped.length; k++) {
      var sk = data.skipped[k];
      $('skipped-list').appendChild(el('li', null, (sk.adName ? sk.adName + '/' : '') + sk.fileName + ': ' + sk.reason));
    }
  }
})();
`;

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
  <p class="empty" id="empty" hidden>No ads yet. Put an MP4, JPG or PNG inside a subfolder of the Drive folder and it appears here after the next sync.</p>
  <section class="skipped" id="skipped" hidden>
    <h2>Found in Drive but not playing</h2>
    <ul id="skipped-list"></ul>
  </section>
</main>
<!-- Phase 3: the player mounts here and plays window.ADS_MANIFEST.ads in order. -->
<div id="player-root" hidden></div>
<script type="application/json" id="ads-data">${embedJson(manifest)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
