// Map + timeline demo screen (#15-#18, #21). Same-origin API, fixture fallback.
const NEWLAB = [42.3337, -83.0727];
const POLL_MS = 5000;
// Map pins. Each state has its own shape and symbol, so a pin reads without the legend
// (and without relying on color alone):
//   still there      yellow badge with "!", the biggest: the thing we want you to see
//   not reported     dark badge, white ring, camera symbol: our camera found it
//   fixed            green badge with a check mark
//   not checked yet  small plain gray dot, so the many city-only spots stay quiet
const PIN = {
  still_there: { size: 28, svg: '<circle cx="14" cy="14" r="12" fill="#f2c230" stroke="#0f0f10" stroke-width="2"/><path d="M14 8v7" stroke="#141415" stroke-width="2.6" stroke-linecap="round"/><circle cx="14" cy="19.5" r="1.6" fill="#141415"/>' },
  // Camera: just the Lucide camera outline, no disc or ring.
  unreported: { size: 26, svg: '<g transform="translate(1 1)" fill="none" stroke="#ededed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/></g>' },
  fixed_confirmed: { size: 24, svg: '<circle cx="12" cy="12" r="11" fill="#4cc38a"/><path d="m8 12.3 2.7 2.7L16 9.6" fill="none" stroke="#0f0f10" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' },
  reported_only: { size: 14, svg: '<circle cx="7" cy="7" r="5.5" fill="#8e8e94" stroke="#0f0f10" stroke-width="1.5"/>' },
};
PIN.unknown = PIN.reported_only;

// The pin symbol as an <svg>, drawn `px` wide. Used on the map, in the legend, the list
// and the empty state, so a state looks the same everywhere.
function pinSvg(state, px, cls = '') {
  const pin = PIN[state] || PIN.unknown;
  return `<svg class="${cls}" viewBox="0 0 ${pin.size} ${pin.size}" width="${px}" height="${px}" aria-hidden="true">${pin.svg}</svg>`;
}

function pinIcon(state, selected) {
  const pin = PIN[state] || PIN.unknown;
  return L.divIcon({
    className: `pin pin-${state}${selected ? ' selected' : ''}`,
    html: pinSvg(state, pin.size),
    iconSize: [pin.size, pin.size],
    iconAnchor: [pin.size / 2, pin.size / 2],
  });
}

// Same wording as the evidence report (report.js), so a state reads the same everywhere.
const LABEL = {
  still_there: 'Still there after closing',
  unreported: 'Not reported to the city',
  fixed_confirmed: 'Fixed',
  reported_only: 'Not checked yet',
  unknown: 'Not enough evidence',
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
// Short date in the list rows: no year when it is this year.
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(iso).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }), timeZone: 'America/Detroit' });
const fmtTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Detroit' });
const days = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const order = (p) => ({ still_there: 3, unreported: 2, fixed_confirmed: 1 }[p.state] || 0);

// The report page. On Vercel it is /report; when the files are opened straight from
// the repo (local testing) that short path does not exist, so use the file itself.
const REPORT_PAGE = location.pathname.startsWith('/apps/') ? '/apps/map/report.html' : '/report';

let live = false; // true when the data came from the API, false for the sample file

async function load() {
  try {
    const r = await fetch('/api/potholes', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    live = true;
    return (await r.json()).potholes;
  } catch (e) {
    console.warn('API failed, using fixtures', e);
    live = false;
    const r = await fetch('/shared/fixtures/potholes.sample.json');
    return (await r.json()).potholes;
  }
}

function draw() {
  const seen = new Set();
  // Important pins drawn last so they sit on top.
  for (const p of [...potholes].sort((a, b) => order(a) - order(b))) {
    seen.add(p.pothole_id);
    const look = `${p.state}|${p.pothole_id === selectedId}`;
    let m = markers.get(p.pothole_id);
    if (!m) {
      m = L.marker([p.lat, p.lon], { icon: pinIcon(p.state, p.pothole_id === selectedId), keyboard: false }).addTo(layer);
      m.on('click', () => select(p.pothole_id));
      m.bindTooltip(() => esc(byId(p.pothole_id)?.address || ''), { direction: 'top', offset: [0, -12] });
      markers.set(p.pothole_id, m);
    } else {
      m.setLatLng([p.lat, p.lon]);
      if (m.look !== look) m.setIcon(pinIcon(p.state, p.pothole_id === selectedId));
    }
    m.look = look;
    // Important pins on top of the gray ones; the picked pin on top of everything.
    m.setZIndexOffset(p.pothole_id === selectedId ? 1000 : order(p) * 100);
  }
  for (const [id, m] of markers) if (!seen.has(id)) { layer.removeLayer(m); markers.delete(id); }

  // Top bar: totals, and whether this is live data or the saved sample.
  document.getElementById('t-spots').textContent = potholes.length;
  document.getElementById('t-reports').textContent = potholes.reduce((n, p) => n + p.city_reports.length, 0);
  document.getElementById('t-still').textContent = countState('still_there');
  const source = document.getElementById('source');
  source.className = `source ${live ? 'live' : 'sample'}`;
  source.textContent = live
    ? `Live, ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : 'Sample data';

  if (!fitted && potholes.length) {
    fitted = true;
    if (!selectedId) map.fitBounds(L.latLngBounds(potholes.map((p) => [p.lat, p.lon])), { padding: [40, 40] });
  }
}

const byId = (id) => potholes.find((p) => p.pothole_id === id);
// Gray pins cover two states (not checked yet, not enough evidence), so count them together.
const stateOf = (p) => (p.state === 'unknown' ? 'reported_only' : p.state);
const countState = (state) => potholes.filter((p) => stateOf(p) === state).length;
const LEGEND = [
  ['still_there', 'Still there'],
  ['unreported', 'Not reported'],
  ['fixed_confirmed', 'Fixed'],
  ['reported_only', 'Not checked'],
];
let filter = null; // a state from LEGEND, or null for all spots

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


function select(id, pan = true) {
  const p = byId(id);
  if (!p) return;
  const changed = selectedId !== id;
  selectedId = id;
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  draw(); // redraw pins so the picked one gets its ring
  if (pan) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
  if (changed) { lastPanelHtml = ''; panel.scrollTop = 0; }
  renderSpot(p);
}

function showList() {
  selectedId = null;
  history.replaceState(null, '', location.pathname);
  draw(); // drop the ring from the pin that was picked
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
  const rows = potholes
    .filter((p) => !filter || stateOf(p) === filter)
    .map((p) => ({ p, f: facts(p) }))
    .sort((a, b) =>
      order(b.p) - order(a.p)
      || b.f.reports.length - a.f.reports.length
      || String(b.f.reports.at(-1)?.created_at || '').localeCompare(String(a.f.reports.at(-1)?.created_at || '')));

  setPanel(`
    <!-- Legend: what each pin color means, with counts. Click one to show only those. -->
    <div class="legend" role="group" aria-label="Pin colors">
      ${LEGEND.map(([state, name]) => `<button type="button" class="chip" data-state="${state}" aria-pressed="${filter === state}">
        ${pinSvg(state, 16, 'dot')}${name}<b>${countState(state)}</b></button>`).join('')}
    </div>
    <header class="panel-head">
      <h1 class="panel-title">${filter ? esc(LEGEND.find(([s]) => s === filter)[1]) : 'All spots'}</h1>
      <p class="panel-sub">${rows.length ? 'Most important first' : 'None yet'}</p>
    </header>
    <ul class="spots">
      ${rows.map(({ p, f }) => `
        <li><button type="button" class="spot-row" data-id="${esc(p.pothole_id)}">
          ${pinSvg(stateOf(p), 16, 'dot')}
          <span class="spot-text">
            <span class="spot-name">${esc(p.address || 'Unnamed spot')}</span>
            <span class="spot-line">${esc(listLine(p, f))}</span>
          </span>
          ${order(p) > 0 ? `<span class="spot-tag ${esc(p.state)}">${esc(SHORT[p.state])}</span>` : ''}
        </button></li>`).join('')}
    </ul>`);
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
      ? `Closed ${shortDate(r.closed_at)}, ${plural(days(r.created_at, r.closed_at), 'day')}`
      : 'Still open';
    return `<li>
      <a class="row-id" href="${esc(r.issue_url)}" target="_blank" rel="noopener">#${esc(r.issue_id)}</a>
      <span class="row-main">Filed ${esc(shortDate(r.created_at))}</span>
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
      <p class="status ${esc(p.state)}">${pinSvg(stateOf(p), 16, 'dot')}${esc(LABEL[p.state] || p.state)}</p>
    </header>

    <dl class="stats n${stats.length}">
      ${stats.map(([k, v, cls]) => `<div class="${cls || ''}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
    </dl>

    <section class="block">
      <h2>City reports</h2>
      ${cityPhoto ? `<img class="shot" src="${esc(cityPhoto.photo_url)}" alt="Photo from city report ${esc(cityPhoto.issue_id)}" onerror="this.remove()">` : ''}
      ${f.reports.length ? `<ol class="rows">${reportRows}</ol>` : '<p class="note">No city report</p>'}
    </section>

    <section class="block">
      <h2>Our cameras</h2>
      ${frame?.image_url ? `<img class="shot" src="${esc(frame.image_url)}" alt="Our camera frame" onerror="this.remove()">` : ''}
      ${f.dets.length ? `<ol class="rows">${camRows}</ol>` : '<p class="note">Not checked yet</p>'}
    </section>

    <section class="block owner">
      <h2>Who fixes it</h2>
      <p><b>${esc(owner.agency.short)}</b>, ${esc(owner.kind.toLowerCase())}</p>
    </section>

    <a class="report-link" href="${REPORT_PAGE}?id=${encodeURIComponent(p.pothole_id)}">Evidence report and PDF</a>

    <dl class="details">
      <div><dt>Location</dt><dd><a href="https://www.google.com/maps?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)}" target="_blank" rel="noopener">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} ↗</a></dd></div>
      <div><dt>Spot ID</dt><dd>${esc(p.pothole_id)}</dd></div>
    </dl>`);
}

// Clicks inside the panel: a legend chip, a spot in the list, or the back button.
panel.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    filter = filter === chip.dataset.state ? null : chip.dataset.state;
    panel.scrollTop = 0;
    return renderList();
  }
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
