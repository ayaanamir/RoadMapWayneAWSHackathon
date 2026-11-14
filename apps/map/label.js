// /label — team review of teacher-labelled dash-cam frames.
// Talks to the same-origin internal API /api/labels. All box math is normalised 0-1
// (top-left origin, {x,y,w,h} as fractions of the image), so it is independent of screen size.
const API = '/api/labels';
const $ = (id) => document.getElementById(id);
const MIN_DRAG_PX = 6;

let who = '';
let frame = null;          // frame being reviewed (null between frames)
let boxes = [];            // editable pothole boxes (normalised)
let history = [];          // snapshots of `boxes` for undo
let showLook = true;
let startedAt = 0;
let busy = false;          // a save/next request is in flight
let retryNext = false;     // last "next" fetch failed: Enter retries it
let draft = null;          // box currently being dragged: {x0,y0,x1,y1} normalised

// ---------- small helpers ----------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* private mode */ } return null; }
function banner(msg) { const b = $('banner'); b.textContent = msg || ''; b.hidden = !msg; }
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const round = (n) => Math.round(n * 10000) / 10000;

// ---------- name gate ----------
function start() {
  who = (store('label_name') || '').trim();
  if (who) return begin();
  $('nameForm').hidden = false;
  $('nameInput').focus();
}
$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  who = $('nameInput').value.trim();
  if (!who) return;
  store('label_name', who);
  $('nameForm').hidden = true;
  begin();
});
function begin() {
  $('who').textContent = who;
  $('who').title = 'click to change name';
  $('who').style.cursor = 'pointer';
  $('who').onclick = () => { releaseFrame(); try { localStorage.removeItem('label_name'); } catch {} location.reload(); };
  loadNext();
}

// ---------- stats (progress + leaderboard) ----------
async function refreshStats() {
  try {
    const s = await api('GET', `${API}?stats=1`);
    renderStats(s);
    return s;
  } catch { return null; }
}
function renderStats(s) {
  const done = (s.reviewed || 0);
  $('progtxt').textContent = `${done} / ${s.total} reviewed · test left ${s.test_left} · train left ${s.train_left}`;
  $('progbar').style.width = (s.total ? (100 * done / s.total) : 0) + '%';
  const top = Object.entries(s.by_reviewer || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('board').innerHTML = '';
  for (const [name, n] of top) {
    const li = document.createElement('li');
    li.textContent = `${name} ${n}`;
    if (name === who) li.className = 'me';
    $('board').appendChild(li);
  }
  const e = $('emptyStats');
  if (e) e.textContent = `${done} of ${s.total} frames reviewed (${s.potholes ?? 0} with potholes, ${s.empty ?? 0} empty, ${s.skipped ?? 0} skipped).`;
}

// ---------- loading frames ----------
function preload(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('image failed to load'));
    im.src = url;
  });
}
async function loadNext() {
  busy = true; retryNext = false; banner('');
  $('stage').classList.add('busy');
  try {
    const { frame: f } = await api('GET', `${API}?next=1&who=${encodeURIComponent(who)}`);
    if (!f) {
      frame = null;
      $('stage').hidden = true; $('tools').hidden = true; $('empty').hidden = false;
      $('split').hidden = true; $('fid').textContent = ''; $('tnote').textContent = '';
      await refreshStats();
      return;
    }
    await preload(f.image_url);          // show only once the image is ready
    frame = f;
    boxes = ((f.teacher && f.teacher.potholes) || []).map(({ x, y, w, h }) => ({ x, y, w, h }));
    history = []; draft = null; startedAt = Date.now();
    $('img').src = f.image_url;
    $('empty').hidden = true; $('stage').hidden = false; $('tools').hidden = false;
    renderHeader();
    fit(); render();
  } catch (err) {
    frame = null; retryNext = true;
    banner(`Could not load the next frame (${err.message}). Press Enter to retry.`);
  } finally {
    busy = false;
    $('stage').classList.remove('busy');
  }
}
function renderHeader() {
  const sp = $('split');
  sp.hidden = false;
  sp.className = 'badge ' + frame.split;
  sp.textContent = frame.split === 'test' ? 'TEST set — be careful' : 'train';
  $('fid').textContent = frame.frame_id;
  const note = (frame.teacher && frame.teacher.potholes || []).map((p) => p.note).filter(Boolean).join(' · ');
  $('tnote').textContent = note; $('tnote').title = note;
  $('count').textContent = '';
}

// ---------- layout: fit the image in the stage, keep aspect ----------
function fit() {
  const img = $('img'), st = $('stage'), wrap = $('wrap');
  if (!img.naturalWidth) return;
  const aw = st.clientWidth - 16, ah = st.clientHeight - 16;
  const s = Math.min(aw / img.naturalWidth, ah / img.naturalHeight);
  wrap.style.width = Math.floor(img.naturalWidth * s) + 'px';
  wrap.style.height = Math.floor(img.naturalHeight * s) + 'px';
  render();
}
window.addEventListener('resize', fit);
$('img').addEventListener('load', fit);

// ---------- drawing the boxes ----------
// A normalised box {x,y,w,h} becomes percentages of the overlay, which is exactly the image rect.
function boxEl(b, cls, label) {
  const d = document.createElement('div');
  d.className = 'box ' + cls;
  d.style.left = b.x * 100 + '%'; d.style.top = b.y * 100 + '%';
  d.style.width = b.w * 100 + '%'; d.style.height = b.h * 100 + '%';
  if (label) { const k = document.createElement('span'); k.className = 'kind'; k.textContent = label; d.appendChild(k); }
  return d;
}
function render() {
  const o = $('overlay');
  o.innerHTML = '';
  if (!frame) return;
  if (showLook) for (const l of (frame.teacher && frame.teacher.lookalikes) || []) o.appendChild(boxEl(l, 'look', l.kind));
  for (const b of boxes) o.appendChild(boxEl(b, '', ''));
  if (draft) o.appendChild(boxEl(draftBox(), 'draft', ''));
  $('lookBtn').classList.toggle('on', showLook);
  $('count').textContent = `${boxes.length} pothole box${boxes.length === 1 ? '' : 'es'}`;
}
function draftBox() {
  return { x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), w: Math.abs(draft.x1 - draft.x0), h: Math.abs(draft.y1 - draft.y0) };
}

// ---------- editing: drag = new box, tap = delete box under the pointer ----------
function pt(e) {
  // pointer position -> normalised image coords (clamped to the image)
  const r = $('overlay').getBoundingClientRect();
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height), r };
}
function push() { history.push(boxes.map((b) => ({ ...b }))); }
function undo() { if (history.length) { boxes = history.pop(); render(); } }

const ov = $('overlay');
ov.addEventListener('pointerdown', (e) => {
  if (!frame || busy) return;
  const p = pt(e);
  draft = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  ov.setPointerCapture(e.pointerId);
});
ov.addEventListener('pointermove', (e) => {
  if (!draft) return;
  const p = pt(e); draft.x1 = p.x; draft.y1 = p.y; render();
});
ov.addEventListener('pointerup', (e) => {
  if (!draft) return;
  const p = pt(e); draft.x1 = p.x; draft.y1 = p.y;
  const b = draftBox();
  const wpx = b.w * p.r.width, hpx = b.h * p.r.height;   // drag size in screen pixels
  const start = { x: draft.x0, y: draft.y0 };
  draft = null;
  if (Math.max(wpx, hpx) < MIN_DRAG_PX) {
    // a tap/click: delete the smallest box containing the point
    const hit = boxes.map((bb, i) => ({ bb, i })).filter(({ bb }) => start.x >= bb.x && start.x <= bb.x + bb.w && start.y >= bb.y && start.y <= bb.y + bb.h)
      .sort((a, c) => a.bb.w * a.bb.h - c.bb.w * c.bb.h)[0];
    if (hit) { push(); boxes.splice(hit.i, 1); }
  } else if (wpx >= MIN_DRAG_PX && hpx >= MIN_DRAG_PX) {
    push(); boxes.push(b);
  }
  render();
});
ov.addEventListener('pointercancel', () => { draft = null; render(); });

// ---------- saving ----------
async function submit(action) {
  if (busy) return;
  if (!frame) { if (retryNext) loadNext(); return; }
  busy = true; banner('');
  const body = { action, frame_id: frame.frame_id, who };
  if (action === 'review') {
    body.boxes = boxes.map((b) => ({ x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) }));
    body.ms = Date.now() - startedAt;
  }
  try {
    await api('POST', API, body);
  } catch (err) {
    busy = false;   // keep the frame and the edits; Enter retries
    banner(`Save failed (${err.message}). Your boxes are kept. Press Enter to retry.`);
    return;
  }
  busy = false;
  frame = null;     // saved: nothing to release on unload
  refreshStats();
  loadNext();
}
const save = () => submit('review');
const noPothole = () => { if (!frame || busy) return; boxes = []; history = []; submit('review'); };
const skip = () => submit('skip');

// Release the claimed frame if the tab closes (sendBeacon survives unload).
function releaseFrame() {
  if (!frame) return;
  const blob = new Blob([JSON.stringify({ action: 'release', frame_id: frame.frame_id, who })], { type: 'application/json' });
  navigator.sendBeacon(API, blob);
}
window.addEventListener('pagehide', releaseFrame);

// ---------- keys + buttons ----------
const toggleLook = () => { showLook = !showLook; render(); };
const toggleHelp = (on) => { $('help').hidden = on === undefined ? !$('help').hidden : !on; };
const actions = { save, none: noPothole, skip, undo, look: toggleLook, help: () => toggleHelp() };
$('tools').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) actions[b.dataset.act](); });
$('help').addEventListener('click', () => toggleHelp(false));
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('help').hidden) { toggleHelp(false); e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === 'enter' || k === ' ') { e.preventDefault(); if (!e.repeat) save(); }
  else if (k === 'n') noPothole();
  else if (k === 's') skip();
  else if (k === 'l') toggleLook();
  else if (k === 'z') undo();
  else if (k === '?') toggleHelp(true);
});

start();
refreshStats();
