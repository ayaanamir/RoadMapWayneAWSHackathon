// Evidence report (#59, #60) as a formal repair request for the road owner.
// Built only from our data and the city's public records; no AI-written text except
// the vision check's one-line reason for each photo.
//
// Page 1: a dated letter to the road owner: to, re, three numbered paragraphs (the city's
//         record, what our camera saw, the request), exhibit list, sign-off.
// Page 2: the exhibits: A photos, B the city's requests and our camera record.
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
      ask: `Please reopen service ${f.closed.length > 1 ? 'requests' : 'request'} ${issues} and repair the pothole at ${where}.`,
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
  const issues = list(f.reports.map(issue));
  const camera = (d) => d.source === 'live' ? 'phone camera' : 'dash camera';
  const where = esc(p.address || 'this location');
  const longToday = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', ...tz });

  // The letter body: what the city's record says, what we saw, what we ask.
  const paras = [];
  if (f.reports.length) {
    const first = f.reports[0].created_at;
    const last = f.reports.at(-1).created_at;
    const span = date(first) === date(last) ? `on ${esc(date(first))}` : `between ${esc(date(first))} and ${esc(date(last))}`;
    const closedPart = !f.closed.length ? 'None has been marked closed.'
      : f.closed.length === f.reports.length
        ? `${f.closed.length > 1 ? 'Each was' : 'It was'} marked closed, most recently on ${esc(date(f.lastClose))}.`
        : `${f.closed.length} of them ${f.closed.length > 1 ? 'were' : 'was'} marked closed, most recently on ${esc(date(f.lastClose))}.`;
    paras.push(`The City received ${plural(f.reports.length, 'service request')} (${issues}) for a pothole at ${where} ${span}. ${closedPart} See Exhibit B.`);
  } else {
    paras.push(`We found no city service request for a pothole at ${where}.`);
  }
  if (f.latestHit) {
    const after = f.lastClose && f.latestHit.captured_at > f.lastClose
      ? `, ${plural(daysBetween(f.lastClose, f.latestHit.captured_at), 'day')} after the last closure` : '';
    paras.push(`On ${esc(when(f.latestHit.captured_at))}, our ${camera(f.latestHit)} recorded a pothole at this location${after}. See Exhibit A.`);
  } else if (ours) {
    paras.push(`Our ${camera(ours)} passed this location on ${esc(date(ours.captured_at))}. Result: ${esc((VERDICT[ours.verdict] || ours.verdict).toLowerCase())}. See Exhibit A.`);
  } else {
    paras.push('Our cameras have not yet passed this location.');
  }
  paras.push(`<strong>${esc(req.ask)}</strong>`);

  const cityRows = f.reports.map((r) => `<tr>
      <td>${issue(r)}</td>
      <td class="num">${esc(date(r.created_at))}</td>
      <td class="num">${r.closed_at ? esc(date(r.closed_at)) : '–'}</td>
      <td class="num r">${r.closed_at ? daysBetween(r.created_at, r.closed_at) : '–'}</td>
      <td>${esc(r.status || '')}</td>
    </tr>`).join('');
  const ourRows = f.dets.map((d) => `<tr>
      <td class="num">${esc(when(d.captured_at))}</td>
      <td>${d.source === 'live' ? 'Phone' : 'Dash camera'}</td>
      <td>${esc(VERDICT[d.verdict] || d.verdict)}</td>
      <td class="num r">${Math.round(d.confidence * 100)}%</td>
      <td>${esc(d.verdict_reason || '')}</td>
    </tr>`).join('');

  // Reference and page number at the bottom of every printed page.
  document.getElementById('page-foot')?.remove();
  const foot = document.createElement('style');
  foot.id = 'page-foot';
  const cssText = (t) => `"${String(t).replace(/["\\]/g, '')}"`;
  foot.textContent = `@page {
    @bottom-left { content: ${cssText(`Ref. ${ref}`)}; font: 9pt "EB Garamond", Garamond, serif; color: #6b6b70; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 9pt "EB Garamond", Garamond, serif; color: #6b6b70; }
  }`;
  document.head.append(foot);

  sheet.innerHTML = `
    <!-- ===== Page 1: the letter ===== -->
    <header class="letterhead">
      <p class="brand">Still There</p>
      <p class="brand-sub">Road condition evidence · Detroit, Michigan</p>
    </header>

    <div class="dateline">
      <span>${esc(longToday)}</span>
      <span>Ref. ${ref}</span>
    </div>

    <table class="address">
      <tr><th>To</th><td>${esc(owner.agency.name)}<br><span class="muted">Submitted through ${esc(owner.agency.via)}</span></td></tr>
      <tr><th>Re</th><td><strong>${esc(req.title)}, ${where}</strong><br>
        <span class="muted">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${f.reports.length ? ` · Service ${f.reports.length > 1 ? 'requests' : 'request'} ${f.reports.map((r) => `#${esc(r.issue_id)}`).join(', ')}` : ''}</span></td></tr>
    </table>

    <ol class="paras">${paras.map((t) => `<li>${t}</li>`).join('')}</ol>

    <div class="exhibits">
      <p class="label">Exhibits</p>
      <p>A. Photographs of the location</p>
      <p>B. City service requests and our camera record</p>
    </div>

    <div class="signoff">
      <p>Respectfully submitted,</p>
      <p class="sig">Still There</p>
      <p class="muted">Prepared ${esc(longToday)} from public city records and our camera data. Figures are not edited by hand.</p>
    </div>

    <!-- ===== Page 2: exhibits ===== -->
    <section class="record">
      <section class="exhibit">
        <h2>Exhibit A. Photographs</h2>
        <div class="photos">
          <figure>
            ${img(ours?.image_url, 'Our camera photo', 'Not yet photographed by our cameras')}
            <figcaption>A-1. Our ${ours ? `${camera(ours)}, ${esc(when(ours.captured_at))}` : 'camera'}${ours?.verdict_reason ? `<span>${esc(ours.verdict_reason)}</span>` : ''}</figcaption>
          </figure>
          <figure>
            ${cityReport?.photo_url ? img(cityReport.photo_url, 'City report photo', '')
              : `<div class="none">${cityReport ? 'No photo attached to the city request' : 'Never reported to the city'}</div>`}
            <figcaption>A-2. City request ${cityReport ? `#${esc(cityReport.issue_id)}, filed ${esc(date(cityReport.created_at))}` : ''}</figcaption>
          </figure>
        </div>
      </section>

      <section class="exhibit">
        <h2>Exhibit B. Record</h2>
        <h3>B-1. City service requests</h3>
        ${f.reports.length ? `<table class="data">
          <thead><tr><th>Request</th><th>Filed</th><th>Closed</th><th class="r">Days open</th><th>Status</th></tr></thead>
          <tbody>${cityRows}</tbody>
        </table>` : '<p class="none-line">None on record.</p>'}
        <h3>B-2. Our camera record</h3>
        ${f.dets.length ? `<table class="data">
          <thead><tr><th>Date and time</th><th>Camera</th><th>Result</th><th class="r">Confidence</th><th>Note</th></tr></thead>
          <tbody>${ourRows}</tbody>
        </table>` : '<p class="none-line">None yet.</p>'}
        <p class="note">Method: a camera in a moving car records the road with time and GPS position. A detection
        model flags possible potholes and a vision model confirms each one as pothole, patch or shadow. Sightings
        are matched to city requests within 50 m. City data: Improve Detroit public records.
        Live record: <a href="${esc(liveUrl(p))}">${esc(liveUrl(p).replace(/^https?:\/\//, ''))}</a></p>
      </section>
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
