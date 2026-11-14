// Evidence report (#59, #60): one pothole, built only from our data (no AI text).
const id = new URLSearchParams(location.search).get('id');
const sheet = document.getElementById('sheet');
const CITY_REPORT_PAGE = 'https://detroitmi.gov/how-do-i/report';
const VERDICT = { pothole: 'Pothole confirmed', patch: 'Patched', shadow: 'Shadow, not a pothole', unverified: 'Not verified yet' };
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

function facts(p) {
  const reports = [...p.city_reports].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const closed = reports.filter((r) => r.closed_at);
  const lastClose = closed.map((r) => r.closed_at).sort().at(-1) || null;
  const dets = [...p.detections].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  const seenAfter = lastClose ? dets.filter((d) => d.verdict === 'pothole' && d.captured_at > lastClose) : [];
  const latestHit = (seenAfter.length ? seenAfter : dets.filter((d) => d.verdict === 'pothole')).at(-1) || null;
  const daysToClose = closed.map((r) => daysBetween(r.created_at, r.closed_at));
  return { reports, closed, lastClose, dets, seenAfter, latestHit, daysToClose };
}

// Plain sentence from the facts. Says only what the data shows.
function summary(p, f) {
  const where = p.address || 'this spot';
  const parts = [];
  if (f.reports.length) {
    parts.push(`People reported a pothole at ${where} ${plural(f.reports.length, 'time')} since ${shortDate(f.reports[0].created_at)}.`);
    if (f.closed.length) {
      const fastest = Math.min(...f.daysToClose);
      parts.push(`The city closed ${f.closed.length === f.reports.length && f.closed.length > 1 ? 'every report' : plural(f.closed.length, 'report')}, ` +
        `${fastest <= 1 ? 'one within a day' : `the fastest in ${plural(fastest, 'day')}`}, most recently on ${shortDate(f.lastClose)}.`);
    }
  }
  if (p.state === 'still_there' && f.latestHit) {
    parts.push(`Our camera recorded the pothole still there on ${shortDate(f.latestHit.captured_at)}, ` +
      `${plural(daysBetween(f.lastClose, f.latestHit.captured_at), 'day')} after the city marked it repaired.`);
  } else if (p.state === 'fixed_confirmed') {
    parts.push(`Our latest pass shows the road patched, so the repair held.`);
  } else if (p.state === 'unreported' && f.latestHit) {
    parts.push(`Our camera recorded a pothole here on ${shortDate(f.latestHit.captured_at)}. Nobody has reported it to the city yet.`);
  } else if (!f.dets.length) {
    parts.push(`We have not driven past it yet.`);
  }
  return parts.join(' ');
}

// Message for the road owner (#60). Shown on the page and in the PDF. Never sent.
function reportText(p, f) {
  const loc = `${p.address || 'Unknown address'} (${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})`;
  const lines = [];
  if (p.state === 'still_there') {
    lines.push(`Pothole still present at ${loc}.`);
    if (f.closed.length) lines.push(`Previous reports ${f.closed.map((r) => `#${r.issue_id} (closed ${shortDate(r.closed_at)})`).join(', ')} were marked closed, but the pothole was still there on ${shortDate(f.latestHit.captured_at)}.`);
    lines.push('Please reopen and repair.');
  } else {
    lines.push(`Pothole at ${loc}.`);
    if (f.latestHit) lines.push(`Recorded on ${shortDate(f.latestHit.captured_at)}.`);
    if (f.reports.length) lines.push(`Related reports: ${f.reports.map((r) => `#${r.issue_id}`).join(', ')}.`);
  }
  if (f.latestHit?.image_url) lines.push(`Photo: ${f.latestHit.image_url}`);
  lines.push(`Evidence: ${location.origin}/report?id=${encodeURIComponent(p.pothole_id)}`);
  return lines.join('\n');
}

function render(p) {
  const f = facts(p);
  document.title = `${p.address || p.pothole_id} · Evidence report`;
  document.getElementById('back').href = `/?id=${encodeURIComponent(p.pothole_id)}`;
  const cityReport = [...f.reports].reverse().find((r) => r.photo_url) || f.reports.at(-1);
  const cityPhoto = cityReport?.photo_url;
  const issueLink = (r) => `<a href="${esc(r.issue_url)}" target="_blank" rel="noopener">Issue #${esc(r.issue_id)} ↗</a>`;
  const issueCard = (r) => `<a class="issue-card" href="${esc(r.issue_url)}" target="_blank" rel="noopener">
      <span class="issue-no">Issue #${esc(r.issue_id)}</span>
      <span class="issue-status ${esc((r.status || '').toLowerCase())}">${esc(r.status)}</span>
      <span class="issue-line">Filed ${esc(date(r.created_at))}</span>
      <span class="issue-line">${r.closed_at ? `Closed ${esc(date(r.closed_at))} · ${plural(daysBetween(r.created_at, r.closed_at), 'day')} later` : 'Still open'}</span>
      <span class="issue-addr">${esc(r.address)}</span>
      ${f.reports.length > 1 ? `<span class="issue-more">+ ${plural(f.reports.length - 1, 'more report')} here</span>` : ''}
      <span class="issue-open">${esc(r.issue_url)}</span>
    </a>`;
  const ours = f.latestHit || f.dets.at(-1);
  const img = (src, alt, none) => src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" onerror="this.outerHTML='<div class=none>Image unavailable</div>'">`
    : `<div class="none">${none}</div>`;

  const rows = [];
  for (const r of f.reports) {
    rows.push({ at: r.created_at, what: 'Reported to the city', detail: `<a href="${esc(r.issue_url)}" target="_blank" rel="noopener">Issue #${esc(r.issue_id)}</a>` });
    if (r.closed_at) rows.push({ at: r.closed_at, what: 'Closed by the city', detail: `${plural(daysBetween(r.created_at, r.closed_at), 'day')} after the report` });
  }
  for (const d of f.dets) {
    rows.push({ at: d.captured_at, cls: d.verdict === 'pothole' ? 'seen' : '',
      what: `${d.source === 'live' ? 'Phone camera' : 'Dash camera'}: ${esc(VERDICT[d.verdict] || d.verdict)}`,
      detail: esc(d.verdict_reason || `Detector confidence ${Math.round(d.confidence * 100)}%`) });
  }
  rows.sort((a, b) => new Date(a.at) - new Date(b.at));

  const owner = roadOwner(p.address);
  const sinceClose = f.lastClose && f.latestHit && p.state === 'still_there' ? daysBetween(f.lastClose, f.latestHit.captured_at) : null;
  const text = reportText(p, f);

  sheet.innerHTML = `
    <p class="kicker"><span>Still There evidence report</span><span class="meta">${esc(date(new Date().toISOString()))}</span></p>
    <h1>${esc(p.address || 'Unnamed spot')}</h1>
    <p class="state ${esc(p.state)}">${esc(LABEL[p.state] || p.state)}</p>
    <p class="summary">${esc(summary(p, f))}</p>
    <dl class="facts">
      <div><dt>City reports</dt><dd>${f.reports.length}</dd></div>
      <div><dt>Marked closed</dt><dd>${f.closed.length}</dd></div>
      <div><dt>Times we saw it</dt><dd>${f.dets.filter((d) => d.verdict === 'pothole').length}</dd></div>
      <div><dt>Days since closed</dt><dd>${sinceClose ?? '–'}</dd></div>
    </dl>
    <h2>The city's record and ours</h2>
    <div class="photos">
      <figure>${cityPhoto ? img(cityPhoto, 'City report photo', '') : cityReport ? issueCard(cityReport) : '<div class="none">Never reported to the city</div>'}<figcaption>${cityPhoto ? `City report photo, ${issueLink(cityReport)}` : 'City report'}</figcaption></figure>
      <figure>${img(ours?.image_url, 'Our camera frame', 'Not seen by our cameras yet')}
        <figcaption>${ours ? `Our camera, ${esc(when(ours.captured_at))}` : 'Our camera'}</figcaption>
        ${ours ? `<div class="verdict">${esc(VERDICT[ours.verdict] || ours.verdict)}${ours.verdict_reason ? `. ${esc(ours.verdict_reason)}` : ''}</div>` : ''}
      </figure>
    </div>
    <h2>Timeline</h2>
    <table>
      <thead><tr><th>When</th><th>What</th><th>Detail</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.cls || ''}"><td class="when">${esc(when(r.at))}</td><td>${r.what}</td><td>${r.detail}</td></tr>`).join('')}</tbody>
    </table>
    <section class="send">
      <h2>Send to the road owner</h2>
      <dl class="route">
        <div><dt>To</dt><dd>${esc(owner.agency.name)}</dd></div>
        <div><dt>Why them</dt><dd>${esc(owner.reason)}</dd></div>
        <div><dt>Through</dt><dd>${esc(owner.agency.via)}</dd></div>
      </dl>
      <p class="message-label">Message</p>
      <textarea id="report-text" readonly>${esc(text)}</textarea>
      <pre class="message-print">${esc(text)}</pre>
      <div class="actions no-print">
        <button type="button" class="primary" id="send">Send to ${esc(owner.agency.short)}</button>
        <button type="button" id="copy">Copy text</button>
        ${owner.key === 'city' ? `<a href="${CITY_REPORT_PAGE}" target="_blank" rel="noopener">Open Improve Detroit</a>` : ''}
      </div>
      <p class="sent no-print" id="sent" role="status" hidden></p>
      <p class="demo-note">Demo: the road owner is picked from the street name. Nothing is sent.</p>
    </section>
    <footer class="meta">
      <span>${esc(p.pothole_id)}</span>
      <span>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>
      <span>City data: Improve Detroit</span>
      <span>Our data: Still There cameras</span>
    </footer>`;

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
