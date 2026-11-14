// Map + timeline demo screen (#15-#18, #21). Same-origin API, fixture fallback.
const NEWLAB = [42.3337, -83.0727];
const POLL_MS = 5000;
const STYLE = {
  still_there:     { color: '#f2c230', fillColor: '#f2c230', fillOpacity: 1, weight: 0, radius: 9 },
  unreported:      { color: '#ededed', fillColor: '#141415', fillOpacity: 1, weight: 3, radius: 8 },
  fixed_confirmed: { color: '#4cc38a', fillColor: '#4cc38a', fillOpacity: 1, weight: 0, radius: 7 },
  reported_only:   { color: '#5c5c62', fillColor: '#5c5c62', fillOpacity: 0.9, weight: 0, radius: 5 },
  unknown:         { color: '#5c5c62', fillColor: '#5c5c62', fillOpacity: 0.9, weight: 0, radius: 5 },
};
const LABEL = {
  still_there: 'Seen after the city closed it',
  unreported: 'Seen by us, never reported',
  fixed_confirmed: 'Confirmed fixed',
  reported_only: 'City report only, not checked yet',
  unknown: 'Not enough evidence yet',
};
const VERDICT = { pothole: 'Pothole', patch: 'Patched', shadow: 'Shadow, not a pothole', unverified: 'Not verified yet' };

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
// The city's own record, shown where its photo would be (most reports have no photo).
const issueLink = (r) => `<a href="${esc(r.issue_url)}" target="_blank" rel="noopener">Issue #${esc(r.issue_id)} ↗</a>`;
function issueCard(r, total) {
  const closed = r.closed_at
    ? `Closed ${esc(fmtDate(r.closed_at))} · ${days(r.created_at, r.closed_at)} ${days(r.created_at, r.closed_at) === 1 ? 'day' : 'days'} later`
    : 'Still open';
  return `<a class="issue-card" href="${esc(r.issue_url)}" target="_blank" rel="noopener">
    <span class="issue-no">Issue #${esc(r.issue_id)}</span>
    <span class="issue-status ${esc((r.status || '').toLowerCase())}">${esc(r.status)}</span>
    <span class="issue-line">Filed ${esc(fmtDate(r.created_at))}</span>
    <span class="issue-line">${closed}</span>
    <span class="issue-addr">${esc(r.address)}</span>
    ${total > 1 ? `<span class="issue-more">+ ${total - 1} more ${total - 1 === 1 ? 'report' : 'reports'} here</span>` : ''}
    <span class="issue-open">View on Improve Detroit ↗</span>
  </a>`;
}
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

  const still = potholes.filter((p) => p.state === 'still_there').length;
  const unrep = potholes.filter((p) => p.state === 'unreported').length;
  const reports = potholes.reduce((n, p) => n + p.city_reports.length, 0);
  document.getElementById('summary').innerHTML =
    `<b>${potholes.length}</b> potholes from <b>${reports}</b> city reports · ` +
    `<b>${still}</b> still there after closing · <b>${unrep}</b> never reported`;

  if (!fitted && potholes.length) {
    fitted = true;
    if (!selectedId) map.fitBounds(L.latLngBounds(potholes.map((p) => [p.lat, p.lon])), { padding: [40, 40] });
  }
}

const byId = (id) => potholes.find((p) => p.pothole_id === id);

function select(id, pan = true) {
  selectedId = id;
  const p = byId(id);
  if (!p) return;
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  if (pan) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16));
  renderPanel(p);
}

function renderPanel(p) {
  const events = [];
  for (const r of p.city_reports) {
    events.push({ at: r.created_at, cls: 'report', what: 'Reported to the city',
      why: `<a href="${esc(r.issue_url)}" target="_blank" rel="noopener">Issue ${esc(r.issue_id)}</a>` });
    if (r.closed_at) events.push({ at: r.closed_at, cls: 'closed', what: `Closed by the city`,
      why: (() => { const n = days(r.created_at, r.closed_at); return `${n} ${n === 1 ? 'day' : 'days'} after the report${r.status === 'Archived' ? ' · archived' : ''}`; })() });
  }
  for (const d of p.detections) {
    events.push({ at: d.captured_at, cls: d.verdict === 'patch' ? 'patch' : d.verdict === 'pothole' ? 'seen' : 'report',
      what: d.source === 'live' ? 'Seen by the phone camera' : 'Seen on our drive',
      why: `${esc(VERDICT[d.verdict] || d.verdict)}${d.verdict_reason ? ' · ' + esc(d.verdict_reason) : ''}`, time: true });
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  // Evidence from the city: the report with a photo if any, else the newest report.
  const byNewest = [...p.city_reports].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const cityReport = byNewest.find((r) => r.photo_url) || byNewest[0];
  const ourFrame = p.detections.filter((d) => d.verdict === 'pothole').at(-1) || p.detections.at(-1);
  const photos = (cityReport || ourFrame) ? `
    <div class="photos">
      <figure>${cityReport?.photo_url
          ? `<img src="${esc(cityReport.photo_url)}" alt="City report photo" onerror="this.outerHTML='<div class=none>Photo unavailable</div>'">`
          : cityReport ? issueCard(cityReport, p.city_reports.length) : '<div class="none">Never reported to the city</div>'}
        <figcaption>${cityReport ? `City report · ${issueLink(cityReport)}` : 'City report'}</figcaption></figure>
      <figure>${ourFrame ? `<img src="${esc(ourFrame.image_url)}" alt="Our latest frame" onerror="this.outerHTML='<div class=none>Frame unavailable</div>'">` : '<div class="none">Not driven yet</div>'}
        <figcaption>${ourFrame ? 'Ours, ' + esc(fmtTime(ourFrame.captured_at)) : 'Our footage'}</figcaption>
        ${ourFrame ? `<div class="verdict">${esc(VERDICT[ourFrame.verdict] || ourFrame.verdict)}${ourFrame.verdict_reason ? '. ' + esc(ourFrame.verdict_reason) : ''}</div>` : ''}</figure>
    </div>` : '';

  document.getElementById('panel').innerHTML = `
    <h1 class="place">${esc(p.address || 'Unnamed spot')}</h1>
    <div class="status ${esc(p.state)}"><span class="dot ${esc(p.state)}"></span>${esc(LABEL[p.state] || p.state)}</div>
    <a class="report-link" href="/report?id=${encodeURIComponent(p.pothole_id)}">Evidence report</a>
    ${photos}
    <ol class="timeline">
      ${events.map((e) => `<li class="${e.cls}">
        <div class="meta">${esc(e.time ? fmtTime(e.at) : fmtDate(e.at))}</div>
        <div class="what">${e.what}</div>
        <div class="why">${e.why}</div></li>`).join('')}
    </ol>
    <p class="meta">${esc(p.pothole_id)} · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</p>`;
}

async function tick() {
  potholes = await load();
  draw();
  if (selectedId && byId(selectedId)) {
    const first = !document.querySelector('.place');
    select(selectedId, first);
  }
}

tick();
setInterval(tick, POLL_MS);
