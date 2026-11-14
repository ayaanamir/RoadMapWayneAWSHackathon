// Map + timeline demo screen (#15-#18, #21). Same-origin API, fixture fallback.
const NEWLAB = [42.3337, -83.0727];
const POLL_MS = 5000;
const STYLE = {
  still_there:     { color: '#f2c230', fillColor: '#f2c230', fillOpacity: 1, weight: 0, radius: 9 },
  unreported:      { color: '#ededed', fillColor: '#141415', fillOpacity: 1, weight: 3, radius: 8 },
  fixed_confirmed: { color: '#4cc38a', fillColor: '#4cc38a', fillOpacity: 1, weight: 0, radius: 7 },
  // Gray pins get a dark edge so they stand out from the dark streets.
  reported_only:   { color: '#0f0f10', fillColor: '#8e8e94', fillOpacity: 1, weight: 1.5, radius: 6 },
  unknown:         { color: '#0f0f10', fillColor: '#8e8e94', fillOpacity: 1, weight: 1.5, radius: 6 },
};
// Same wording as the evidence report (report.js), so a state reads the same everywhere.
const LABEL = {
  still_there: 'Still there after the city closed it',
  unreported: 'Seen by us, not reported to the city',
  fixed_confirmed: 'Fixed, checked by us',
  reported_only: 'City report, not checked yet',
  unknown: 'Not enough evidence yet',
};
// Short names for the list tags.
const SHORT = { still_there: 'Still there', unreported: 'Not reported', fixed_confirmed: 'Fixed' };
const VERDICT = { pothole: 'Pothole', patch: 'Patched', shadow: 'Shadow, not a pothole', unverified: 'Not checked yet' };

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView(NEWLAB, 14);
const tiles = window.CARTO_KEY
  ? L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${window.CARTO_KEY}`, {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO · Reports: Improve Detroit',
    })
  : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'osm-dark',
      attribution: '&copy; OpenStreetMap contributors · Reports: Improve Detroit',
    });
tiles.addTo(map);

const layer = L.layerGroup().addTo(map);
const markers = new Map();
let potholes = [];
let selectedId = new URLSearchParams(location.search).get('id');
let fitted = false;

const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Detroit' })
  : '';
const fmtTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Detroit' });
const days = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const order = (p) => ({ still_there: 3, unreported: 2, fixed_confirmed: 1 }[p.state] || 0);

async function load() {
  try {
    const r = await fetch('/api/potholes', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    return (await r.json()).potholes;
  } catch (e) {
    console.warn('API failed, using fixtures', e);
    const r = await fetch('/shared/fixtures/potholes.sample.json');
    return (await r.json()).potholes;
  }
}

function draw() {
  const seen = new Set();
  // Important pins drawn last so they sit on top.
  for (const p of [...potholes].sort((a, b) => order(a) - order(b))) {
    seen.add(p.pothole_id);
    const style = STYLE[p.state] || STYLE.unknown;
    let m = markers.get(p.pothole_id);
    if (!m) {
      m = L.circleMarker([p.lat, p.lon], style).addTo(layer);
      m.on('click', () => select(p.pothole_id));
      m.bindTooltip(() => esc(byId(p.pothole_id)?.address || ''), { direction: 'top', offset: [0, -8] });
      markers.set(p.pothole_id, m);
    } else {
      m.setLatLng([p.lat, p.lon]).setStyle(style).setRadius(style.radius);
    }
    if (order(p) > 0) m.bringToFront();
  }
  for (const [id, m] of markers) if (!seen.has(id)) { layer.removeLayer(m); markers.delete(id); }

  // Header: totals in one short line, and a count next to each legend color.
  const reports = potholes.reduce((n, p) => n + p.city_reports.length, 0);
  document.getElementById('summary').innerHTML =
    `<b>${potholes.length}</b> spots, <b>${reports}</b> city reports`;
  for (const state of ['still_there', 'unreported', 'fixed_confirmed', 'reported_only']) {
    const n = potholes.filter((p) => p.state === state || (state === 'reported_only' && p.state === 'unknown')).length;
    document.getElementById(`n-${state}`).textContent = n;
  }

  if (!fitted && potholes.length) {
    fitted = true;
    if (!selectedId) map.fitBounds(L.latLngBounds(potholes.map((p) => [p.lat, p.lon])), { padding: [40, 40] });
  }
}

const byId = (id) => potholes.find((p) => p.pothole_id === id);

// ---- Sidebar ----
// Two views in the same panel:
//   list: nothing picked. Every spot, the important ones first. Click one to open it.
//   spot: one pothole. Headline numbers, the city's reports, what our cameras saw,
//         who owns the road, and a link to the full evidence report.

const panel = document.getElementById('panel');
let lastPanelHtml = '';

// The panel is rebuilt every 5 s with fresh data. Only touch the page when something
// changed, so the scroll position and hover state are kept.
function setPanel(html) {
  if (html === lastPanelHtml) return;
  const scroll = panel.scrollTop;
  lastPanelHtml = html;
  panel.innerHTML = html;
  panel.scrollTop = scroll;
}

// A ring around the picked pin, so you can see where you are on the map.
const ring = L.circleMarker(NEWLAB, { radius: 15, color: '#ededed', weight: 2, fill: false, interactive: false });

function select(id, pan = true) {
  const p = byId(id);
  if (!p) return;
  const changed = selectedId !== id;
  selectedId = id;
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  ring.setLatLng([p.lat, p.lon]).addTo(map);
  if (pan) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
  if (changed) { lastPanelHtml = ''; panel.scrollTop = 0; }
  renderSpot(p);
}

function showList() {
  selectedId = null;
  history.replaceState(null, '', location.pathname);
  map.removeLayer(ring);
  lastPanelHtml = '';
  panel.scrollTop = 0;
  renderList();
}

// Facts about one spot, used by the spot view and the list rows.
function facts(p) {
  const reports = [...p.city_reports].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const closed = reports.filter((r) => r.closed_at);
  const closeDays = closed.map((r) => days(r.created_at, r.closed_at));
  const lastClose = closed.map((r) => r.closed_at).sort().at(-1) || null;
  const dets = [...p.detections].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  const hits = dets.filter((d) => d.verdict === 'pothole');
  const hitAfterClose = lastClose ? hits.filter((d) => d.captured_at > lastClose).at(-1) : null;
  return {
    reports, closed, dets, hits, lastClose,
    fastest: closeDays.length ? Math.min(...closeDays) : null,
    stillDays: p.state === 'still_there' && hitAfterClose ? days(lastClose, hitAfterClose.captured_at) : null,
  };
}

// One short line under a spot's address in the list.
function listLine(p, f) {
  const parts = [];
  if (f.reports.length) parts.push(`Reported ${f.reports.length}×`);
  if (f.closed.length) parts.push(`closed ${f.closed.length}×`);
  if (f.hits.length) parts.push(`seen ${f.hits.length}× by us`);
  return parts.join(', ') || 'No reports yet';
}

function renderList() {
  // Important first: still there, then not reported, then fixed. Within that, the
  // spots reported most often, then the most recent.
  const rows = [...potholes].map((p) => ({ p, f: facts(p) })).sort((a, b) =>
    order(b.p) - order(a.p)
    || b.f.reports.length - a.f.reports.length
    || String(b.f.reports.at(-1)?.created_at || '').localeCompare(String(a.f.reports.at(-1)?.created_at || '')));

  setPanel(`
    <header class="panel-head">
      <h1 class="panel-title">Spots</h1>
      <p class="panel-sub">${plural(potholes.length, 'spot')} in Corktown, Midtown and Southwest Detroit. Most important first.</p>
    </header>
    <ul class="spots">
      ${rows.map(({ p, f }) => `
        <li><button type="button" class="spot-row" data-id="${esc(p.pothole_id)}">
          <span class="dot ${esc(p.state)}"></span>
          <span class="spot-text">
            <span class="spot-name">${esc(p.address || 'Unnamed spot')}</span>
            <span class="spot-line">${esc(listLine(p, f))}</span>
          </span>
          ${order(p) > 0 ? `<span class="spot-tag ${esc(p.state)}">${esc(SHORT[p.state])}</span>` : ''}
        </button></li>`).join('')}
    </ul>
    <section class="key" aria-label="What the colors mean">
      <h2>What the colors mean</h2>
      <ul>
        <li><span class="dot still_there"></span><span><b>Still there.</b> The city closed the report, and our camera saw the pothole after that.</span></li>
        <li><span class="dot unreported"></span><span><b>Not reported.</b> Our camera found it. The city has no report.</span></li>
        <li><span class="dot fixed_confirmed"></span><span><b>Fixed.</b> Our camera saw the patch.</span></li>
        <li><span class="dot reported_only"></span><span><b>Not checked yet.</b> City reports only. Our cameras have not been there.</span></li>
      </ul>
    </section>`);
}

function renderSpot(p) {
  const f = facts(p);
  const owner = roadOwner(p.address);

  // Headline numbers. "Seen after closing" only when it applies.
  const stats = [
    ['Reported', `${f.reports.length}×`],
    ['Closed', `${f.closed.length}×`],
    ['Fastest close', f.fastest === null ? 'None' : plural(f.fastest, 'day')],
  ];
  if (f.stillDays !== null) stats.push(['Seen after closing', plural(f.stillDays, 'day'), 'still']);

  // One row per city report: filed, then closed (or still open).
  const reportRows = f.reports.map((r) => {
    const outcome = r.closed_at
      ? `Closed ${fmtDate(r.closed_at)}, ${plural(days(r.created_at, r.closed_at), 'day')} later`
      : 'Still open';
    return `<li>
      <a class="row-id" href="${esc(r.issue_url)}" target="_blank" rel="noopener">#${esc(r.issue_id)}</a>
      <span class="row-main">Filed ${esc(fmtDate(r.created_at))}</span>
      <span class="row-sub ${r.closed_at ? '' : 'open'}">${esc(outcome)}</span>
    </li>`;
  }).join('');
  const cityPhoto = [...f.reports].reverse().find((r) => r.photo_url);

  // What our cameras saw, newest first, with the newest frame as a photo.
  const camRows = [...f.dets].reverse().map((d) => `<li class="${d.verdict === 'pothole' ? 'hit' : ''}">
      <span class="row-id">${esc(d.source === 'live' ? 'Phone' : 'Dash cam')}</span>
      <span class="row-main">${esc(VERDICT[d.verdict] || d.verdict)}, ${esc(fmtTime(d.captured_at))}</span>
      ${d.verdict_reason ? `<span class="row-sub">${esc(d.verdict_reason)}</span>` : ''}
    </li>`).join('');
  const frame = f.hits.at(-1) || f.dets.at(-1);

  setPanel(`
    <button type="button" class="back" id="back">← All spots</button>
    <header class="spot-head">
      <h1 class="place">${esc(p.address || 'Unnamed spot')}</h1>
      <p class="status ${esc(p.state)}"><span class="dot ${esc(p.state)}"></span>${esc(LABEL[p.state] || p.state)}</p>
    </header>

    <dl class="stats n${stats.length}">
      ${stats.map(([k, v, cls]) => `<div class="${cls || ''}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
    </dl>

    <section class="block">
      <h2>City reports</h2>
      ${cityPhoto ? `<img class="shot" src="${esc(cityPhoto.photo_url)}" alt="Photo from city report ${esc(cityPhoto.issue_id)}" onerror="this.remove()">` : ''}
      ${f.reports.length ? `<ol class="rows">${reportRows}</ol>` : '<p class="note">None. The city has no report for this spot.</p>'}
    </section>

    <section class="block">
      <h2>Our cameras</h2>
      ${frame?.image_url ? `<img class="shot" src="${esc(frame.image_url)}" alt="Our camera frame" onerror="this.remove()">` : ''}
      ${f.dets.length ? `<ol class="rows">${camRows}</ol>` : '<p class="note">Not checked yet. Our cameras have not been here.</p>'}
    </section>

    <section class="block owner">
      <h2>Who fixes it</h2>
      <p><b>${esc(owner.agency.short)}</b>. ${esc(owner.reason)}</p>
    </section>

    <a class="report-link" href="/report?id=${encodeURIComponent(p.pothole_id)}">Evidence report and PDF</a>
    <p class="meta">${esc(p.pothole_id)}, ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</p>`);
}

// Clicks inside the panel: a spot in the list, or the back button.
panel.addEventListener('click', (e) => {
  const row = e.target.closest('.spot-row');
  if (row) return select(row.dataset.id);
  if (e.target.closest('#back')) showList();
});

async function tick() {
  potholes = await load();
  draw();
  if (selectedId && byId(selectedId)) select(selectedId, !lastPanelHtml);
  else renderList();
}

tick();
setInterval(tick, POLL_MS);
