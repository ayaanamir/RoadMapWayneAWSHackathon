// Evidence report (#59, #60) as a formal repair request for the road owner.
// Built only from our data and the city's public records; no AI-written text except
// the vision check's one-line reason for each photo.
//
// Page 1: what the agency acts on (reference, to whom and why, location, the request,
//         key dates, photos).
// Page 2: the supporting record (city reports, our sightings, how we found it, sources,
//         QR code to the live page).
// On screen the sheet looks like the paper it prints as. The "Send to the road owner"
// panel under it is screen only, and its Send button is a demo: nothing is sent.

const id = new URLSearchParams(location.search).get('id');
const sheet = document.getElementById('sheet');
const sendPanel = document.getElementById('send-panel');
const CITY_REPORT_PAGE = 'https://detroitmi.gov/how-do-i/report';
const VERDICT = { pothole: 'Pothole', patch: 'Patched', shadow: 'Shadow, not a pothole', unverified: 'Not checked yet' };
// Same wording as the map panel (app.js), so a state reads the same everywhere.
const LABEL = {
  still_there: 'Still there after closing',
  unreported: 'Not reported to the city',
  fixed_confirmed: 'Fixed',
  reported_only: 'Not checked yet',
  unknown: 'Not enough evidence',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tz = { timeZone: 'America/Detroit' };
const date = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...tz });
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...tz });
const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', ...tz });
const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const list = (items) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

function facts(p) {
  const reports = [...p.city_reports].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const closed = reports.filter((r) => r.closed_at);
  const lastClose = closed.map((r) => r.closed_at).sort().at(-1) || null;
  const dets = [...p.detections].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  const hits = dets.filter((d) => d.verdict === 'pothole');
  const seenAfter = lastClose ? hits.filter((d) => d.captured_at > lastClose) : [];
  const latestHit = (seenAfter.length ? seenAfter : hits).at(-1) || null;
  return { reports, closed, lastClose, dets, hits, seenAfter, latestHit };
}

// Short reference the agency can quote back, the same every time for one spot.
// "ph_peterboro_73" -> "ST-" + 6 letters/digits.
function reference(potholeId) {
  let h = 2166136261;
  for (const ch of potholeId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O, 1/I
  let out = '';
  for (let i = 0; i < 6; i++) { out += abc[h % 32]; h = Math.floor(h / 32) || 7919 * (i + 1); }
  return `ST-${out}`;
}

// What we ask the agency to do, by state. One or two plain sentences.
function request(p, f) {
  const where = p.address || 'this location';
  const issues = list(f.reports.map((r) => `#${r.issue_id}`));
  if (p.state === 'still_there' && f.latestHit) {
    const days = daysBetween(f.lastClose, f.latestHit.captured_at);
    return {
      title: 'Pothole repair request',
      ask: `Please reopen ${f.closed.length > 1 ? 'issues' : 'issue'} ${issues} and repair the pothole at ${where}.`,
      basis: `${f.closed.length > 1 ? 'All were' : 'It was'} marked closed, most recently on ${date(f.lastClose)}, but our camera recorded the pothole still there on ${date(f.latestHit.captured_at)}, ${plural(days, 'day')} later.`,
    };
  }
  if (p.state === 'unreported' && f.latestHit) {
    return {
      title: 'Pothole repair request',
      ask: `Please open a repair request for a pothole at ${where}.`,
      basis: `Our camera recorded it on ${date(f.latestHit.captured_at)}. It has not been reported to the city.`,
    };
  }
  if (p.state === 'fixed_confirmed') {
    const last = f.dets.at(-1);
    return {
      title: 'Repair check',
      ask: `No action needed at ${where}.`,
      basis: `${f.reports.length ? `${plural(f.reports.length, 'report')} (${issues}) ${f.reports.length > 1 ? 'were' : 'was'} closed, and our` : 'Our'} camera on ${last ? date(last.captured_at) : 'our last pass'} shows the road repaired.`,
    };
  }
  return {
    title: 'Pothole inspection request',
    ask: `Please inspect the reported pothole at ${where}${f.reports.length ? ` (${issues})` : ''}.`,
    basis: f.dets.length ? 'Our cameras have not confirmed it either way yet.' : 'Our cameras have not driven past it yet.',
  };
}

// Message for the road owner's form or email (#60). Screen only, never sent.
function messageText(p, f, ref, req) {
  const loc = `${p.address || 'Unknown address'} (${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})`;
  const lines = [`${req.title}, ref ${ref}`, `Location: ${loc}`, req.ask, req.basis];
  if (f.latestHit?.image_url) lines.push(`Photo: ${f.latestHit.image_url}`);
  lines.push(`Evidence: ${liveUrl(p)}`);
  return lines.join('\n');
}

function liveUrl(p) {
  return `${location.origin}/report?id=${encodeURIComponent(p.pothole_id)}`;
}

// ---- Small map: OpenStreetMap tiles around the spot, pin in the middle ----

function mapTiles(lat, lon, w = 300, h = 170, z = 17) {
  const scale = 256 * 2 ** z;
  const x = ((lon + 180) / 360) * scale;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
  const left = x - w / 2;
  const top = y - h / 2;
  const tiles = [];
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + w) / 256); tx++) {
    for (let ty = Math.floor(top / 256); ty <= Math.floor((top + h) / 256); ty++) {
      tiles.push(`<img src="https://tile.openstreetmap.org/${z}/${tx}/${ty}.png" alt="" style="left:${Math.round(tx * 256 - left)}px;top:${Math.round(ty * 256 - top)}px">`);
    }
  }
  return `<div class="map" style="width:${w}px;height:${h}px" role="img" aria-label="Map of the location">
    ${tiles.join('')}
    <span class="map-pin" style="left:${w / 2}px;top:${h / 2}px"></span>
    <span class="map-credit">© OpenStreetMap contributors</span>
  </div>`;
}

// QR code to the live evidence page (qrcode-generator from cdnjs). Empty if it did not load.
function qrSvg(text) {
  if (typeof qrcode !== 'function') return '';
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
}

function render(p) {
  const f = facts(p);
  const ref = reference(p.pothole_id);
  const req = request(p, f);
  const owner = roadOwner(p.address);
  const today = date(new Date().toISOString());
  document.title = `${ref} · ${p.address || p.pothole_id}`;
  // Back to the map. "/" on Vercel; the file itself when testing from the repo.
  const mapPage = location.pathname.startsWith('/apps/') ? '/apps/map/index.html' : '/';
  document.getElementById('back').href = `${mapPage}?id=${encodeURIComponent(p.pothole_id)}`;

  const cityReport = [...f.reports].reverse().find((r) => r.photo_url) || f.reports.at(-1);
  const ours = f.latestHit || f.dets.at(-1);
  const img = (src, alt, none) => src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" onerror="this.outerHTML='<div class=none>Photo not available</div>'">`
    : `<div class="none">${none}</div>`;
  const issue = (r) => `<a href="${esc(r.issue_url)}" target="_blank" rel="noopener">#${esc(r.issue_id)}</a>`;
  const sinceClose = f.lastClose && f.latestHit && p.state === 'still_there' ? daysBetween(f.lastClose, f.latestHit.captured_at) : null;

  // Key dates, only the ones we have.
  const keyFacts = [
    f.reports.length && ['First reported', date(f.reports[0].created_at)],
    f.reports.length && ['City reports', `${f.reports.length}, ${f.closed.length} closed`],
    f.lastClose && ['Last closed', date(f.lastClose)],
    f.latestHit && [p.state === 'still_there' ? 'Seen still there' : 'Seen by our camera', date(f.latestHit.captured_at)],
    sinceClose != null && ['Days after closing', String(sinceClose)],
  ].filter(Boolean);

  const cityRows = f.reports.map((r) => `<tr>
      <td>${issue(r)}</td>
      <td class="num">${esc(date(r.created_at))}</td>
      <td class="num">${r.closed_at ? esc(date(r.closed_at)) : '–'}</td>
      <td class="num r">${r.closed_at ? daysBetween(r.created_at, r.closed_at) : '–'}</td>
      <td>${esc(r.status || '')}</td>
    </tr>`).join('');
  const ourRows = f.dets.map((d) => `<tr class="${d.verdict === 'pothole' ? 'hit' : ''}">
      <td class="num">${esc(when(d.captured_at))}</td>
      <td>${d.source === 'live' ? 'Phone' : 'Dash camera'}</td>
      <td>${esc(VERDICT[d.verdict] || d.verdict)}</td>
      <td class="num r">${Math.round(d.confidence * 100)}%</td>
      <td>${esc(d.verdict_reason || '')}${d.image_url ? ` <a href="${esc(d.image_url)}" target="_blank" rel="noopener">Photo</a>` : ''}</td>
    </tr>`).join('');

  // Reference, address and page number at the bottom of every printed page.
  document.getElementById('page-foot')?.remove();
  const foot = document.createElement('style');
  foot.id = 'page-foot';
  const cssText = (t) => `"${String(t).replace(/["\\]/g, '')}"`;
  foot.textContent = `@page {
    @bottom-left { content: ${cssText(`${ref} · ${p.address || ''}`)}; font: 8pt "Geist Mono", monospace; color: #6b6b70; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt "Geist Mono", monospace; color: #6b6b70; }
  }`;
  document.head.append(foot);

  sheet.innerHTML = `
    <!-- ===== Page 1: the request ===== -->
    <header class="doc-head">
      <div class="doc-from">
        <p class="doc-brand">Still There</p>
        <p class="doc-sub">Road condition evidence, Detroit</p>
      </div>
      <table class="doc-ref">
        <tr><th>Reference</th><td>${ref}</td></tr>
        <tr><th>Prepared</th><td>${esc(today)}</td></tr>
        <tr><th>Status</th><td>${esc(LABEL[p.state] || p.state)}</td></tr>
      </table>
    </header>

    <h1>${esc(req.title)}</h1>
    <p class="doc-for">${esc(p.address || 'Unnamed location')}</p>

    <section class="block where">
      <h2><span>1</span>Location and jurisdiction</h2>
      <div class="where-grid">
        <table class="fields">
          <tr><th>Addressed to</th><td>${esc(owner.agency.name)}</td></tr>
          <tr><th>Jurisdiction</th><td>${esc(owner.reason)}</td></tr>
          <tr><th>Submit through</th><td>${esc(owner.agency.via)}</td></tr>
          <tr><th>Address</th><td>${esc(p.address || '–')}</td></tr>
          <tr><th>Coordinates</th><td class="num">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}
            <a class="no-print-link" href="https://www.google.com/maps?q=${p.lat},${p.lon}" target="_blank" rel="noopener">Open in Maps</a></td></tr>
        </table>
        ${mapTiles(p.lat, p.lon)}
      </div>
    </section>

    <section class="block request">
      <h2><span>2</span>Request</h2>
      <p class="ask">${esc(req.ask)}</p>
      <p class="basis">${esc(req.basis)}</p>
    </section>

    ${keyFacts.length ? `<section class="block">
      <h2><span>3</span>Key dates</h2>
      <dl class="key">${keyFacts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    </section>` : ''}

    <section class="block">
      <h2><span>4</span>Photo evidence</h2>
      <div class="photos">
        <figure>
          ${img(ours?.image_url, 'Our camera photo', 'Not seen by our cameras yet')}
          <figcaption>${ours
            ? `<b>A. Our camera, ${esc(when(ours.captured_at))}</b>
               <span>${ours.source === 'live' ? 'Phone' : 'Dash camera'}, result: ${esc(VERDICT[ours.verdict] || ours.verdict)}${ours.verdict_reason ? `. ${esc(ours.verdict_reason)}` : ''}</span>`
            : '<b>A. Our camera</b>'}</figcaption>
        </figure>
        <figure>
          ${cityReport?.photo_url ? img(cityReport.photo_url, 'City report photo', '')
            : `<div class="none">${cityReport ? 'No photo on the city report' : 'Never reported to the city'}</div>`}
          <figcaption>${cityReport
            ? `<b>B. City report ${issue(cityReport)}</b><span>Filed ${esc(date(cityReport.created_at))}${cityReport.closed_at ? `, closed ${esc(date(cityReport.closed_at))}` : ''}</span>`
            : '<b>B. City report</b>'}</figcaption>
        </figure>
      </div>
    </section>

    <!-- ===== Page 2: the supporting record ===== -->
    <section class="record">
      <section class="block">
        <h2><span>5</span>City service requests</h2>
        ${f.reports.length ? `<table class="data">
          <thead><tr><th>Issue</th><th>Filed</th><th>Closed</th><th class="r">Days open</th><th>Status</th></tr></thead>
          <tbody>${cityRows}</tbody>
        </table>` : '<p class="none-line">None. This location has not been reported to the city.</p>'}
      </section>

      <section class="block">
        <h2><span>6</span>Our sightings</h2>
        ${f.dets.length ? `<table class="data">
          <thead><tr><th>Date and time</th><th>Camera</th><th>Result</th><th class="r">Confidence</th><th>Note</th></tr></thead>
          <tbody>${ourRows}</tbody>
        </table>` : '<p class="none-line">None yet.</p>'}
      </section>

      <section class="block about">
        <div>
          <h2><span>7</span>Method</h2>
          <p>A phone or dash camera in a moving car records the road. A detection model marks
          possible potholes and saves each photo with its time and GPS position. A second check
          by an AI vision model labels each photo as pothole, patch or shadow; only "pothole"
          counts as a sighting. Sightings are matched to city reports within 50 m.</p>
          <h2><span>8</span>Data sources</h2>
          <p>City reports: Improve Detroit (SeeClickFix), public records. Report locations are
          geocoded by the city and can be 10 to 50 m off. Photos and sightings: Still There
          cameras. Road owner: determined from the street name.</p>
        </div>
        <figure class="qr">
          ${qrSvg(liveUrl(p))}
          <figcaption>Scan for the live evidence page</figcaption>
        </figure>
      </section>

      <p class="attest">Prepared automatically by Still There on ${esc(today)} from public city records
      and our camera data. Figures are not edited by hand. Reference ${ref}.</p>
    </section>`;

  // Screen-only panel: the message for the road owner's form, and a demo Send.
  const text = messageText(p, f, ref, req);
  sendPanel.hidden = false;
  sendPanel.innerHTML = `
    <h2>Send to the road owner</h2>
    <p class="send-to">${esc(owner.agency.name)}, through ${esc(owner.agency.via)}</p>
    <textarea id="report-text" readonly aria-label="Message">${esc(text)}</textarea>
    <div class="actions">
      <button type="button" class="primary" id="send">Send to ${esc(owner.agency.short)}</button>
      <button type="button" id="copy">Copy text</button>
      ${owner.key === 'city' ? `<a href="${CITY_REPORT_PAGE}" target="_blank" rel="noopener">Open Improve Detroit</a>` : ''}
    </div>
    <p class="sent" id="sent" role="status" hidden></p>
    <p class="demo-note">Demo: nothing is sent. The PDF is the same request on paper.</p>`;

  const sent = document.getElementById('sent');
  document.getElementById('copy').onclick = async () => {
    const ta = document.getElementById('report-text');
    try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
    sent.hidden = false;
    sent.textContent = 'Copied';
  };
  // Mock send: only shows what would happen. No network call.
  document.getElementById('send').onclick = () => {
    sent.hidden = false;
    sent.textContent = `Demo only, not sent. A real version would file this with ${owner.agency.short} through ${owner.agency.via}.`;
  };
}

document.getElementById('print').onclick = () => window.print();

(async () => {
  if (!id) { sheet.innerHTML = '<p class="muted">No pothole picked. Open one from the map.</p>'; return; }
  let p = null;
  try {
    const r = await fetch(`/api/potholes?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (r.ok) p = await r.json();
  } catch (e) { console.warn(e); }
  if (!p) {
    try { p = (await (await fetch('/shared/fixtures/potholes.sample.json')).json()).potholes.find((x) => x.pothole_id === id); } catch {}
  }
  if (!p) { sheet.innerHTML = `<p class="muted">No pothole ${esc(id)}.</p>`; return; }
  render(p);
})();
