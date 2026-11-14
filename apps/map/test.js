// /test — measure the pothole model on pre-recorded footage, in the browser.
// Frames are sampled from a local video, run through a model (same preprocessing as
// /live), and scored per frame against the marks you make:
//   hit = frame has a box >= threshold AND you marked a pothole
//   false box = box >= threshold, not marked; miss = marked, no box >= threshold
import { Detector } from './test-detector.js';

const LIVE_MODEL_URL = 'https://pub-9da122d7960d49de90da1a69cb4fe7f9.r2.dev/models/pothole.onnx'; // = apps/live/config.js MODEL_URL
const LIVE_THRESHOLD = 0.35;
const THUMB_W = 320;

const $ = (id) => document.getElementById(id);
const video = $('video');
const state = {
  file: null,
  fps: 3,
  frames: [],         // [{ t, thumb: canvas }]
  marks: new Set(),   // frame indices with a real pothole
  runs: [],           // [{ name, crop, ms, backend, boxes: [[box]] }]
  shown: -1,          // run whose boxes are drawn on the frames
  thr: LIVE_THRESHOLD,
  open: -1,           // frame open in the viewer
  busy: false,
};

// ---------- video + frames ----------

$('videoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.file = file;
  $('videoName').textContent = file.name;
  video.src = URL.createObjectURL(file);
  await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error('This browser cannot play that video.')); })
    .catch((err) => { $('videoInfo').textContent = err.message; throw err; });
  // Browser/screen recordings (webm) often have no duration until you seek to the end.
  if (!Number.isFinite(video.duration)) {
    await new Promise((ok) => {
      video.ondurationchange = () => { if (Number.isFinite(video.duration)) { video.ondurationchange = null; ok(); } };
      video.currentTime = 1e101;
    });
  }
  await sampleFrames();
});
$('fps').addEventListener('change', () => state.file && sampleFrames());

function seek(t) {
  if (Math.abs(video.currentTime - t) < 1e-6 && video.readyState >= 2) return Promise.resolve();
  return new Promise((ok) => {
    const done = () => { video.removeEventListener('seeked', done); ok(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

async function sampleFrames() {
  if (state.busy) return;
  state.busy = true;
  state.fps = Number($('fps').value);
  state.runs = []; state.shown = -1; state.frames = [];
  const n = Math.max(1, Math.floor(video.duration * state.fps));
  const w = video.videoWidth, h = video.videoHeight;
  $('videoInfo').textContent = `${fmtTime(video.duration)} · ${w}×${h} · ${n} frames`;
  progress(0);
  for (let i = 0; i < n; i++) {
    const t = Math.min(video.duration - 0.05, i / state.fps + 0.001);
    await seek(t);
    const c = document.createElement('canvas');
    c.width = THUMB_W; c.height = Math.round(THUMB_W * h / w);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    state.frames.push({ t, thumb: c });
    progress((i + 1) / n);
  }
  progress(null);
  loadMarks();
  state.busy = false;
  $('run').disabled = false;
  renderAll();
}

// ---------- models ----------

const detectors = new Map(); // cache by name
async function getDetector() {
  const useFile = document.querySelector('input[name=model]:checked').value === 'file';
  let name, bytes;
  if (useFile) {
    const f = $('modelFile').files[0];
    if (!f) throw new Error('Choose a .onnx file first.');
    name = f.name;
    if (detectors.has(name)) return detectors.get(name);
    bytes = new Uint8Array(await f.arrayBuffer());
  } else {
    name = 'live pothole.onnx';
    if (detectors.has(name)) return detectors.get(name);
    $('runInfo').textContent = 'Downloading the live model…';
    const r = await fetch(LIVE_MODEL_URL);
    if (!r.ok) throw new Error(`Could not download the live model (HTTP ${r.status}).`);
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  $('runInfo').textContent = `Starting ${name}…`;
  const d = new Detector(name);
  await d.load(bytes);
  detectors.set(name, d);
  return d;
}
$('modelFile').addEventListener('change', () => { document.querySelector('input[name=model][value=file]').checked = true; });

$('run').addEventListener('click', async () => {
  if (state.busy || !state.frames.length) return;
  state.busy = true; $('run').disabled = true;
  try {
    const det = await getDetector();
    const crop = Number($('crop').value);
    const w = video.videoWidth, h = video.videoHeight;
    const run = { name: det.name + (crop ? ` · bottom ${Math.round((1 - crop) * 100)}%` : ''), crop, backend: det.backend, boxes: [], ms: 0 };
    progress(0);
    for (let i = 0; i < state.frames.length; i++) {
      await seek(state.frames[i].t);
      const { boxes, ms } = await det.detect(video, w, h, crop);
      run.boxes.push(boxes); run.ms += ms;
      progress((i + 1) / state.frames.length);
      $('runInfo').textContent = `${det.name}: frame ${i + 1} of ${state.frames.length}`;
    }
    run.ms /= state.frames.length;
    const same = state.runs.findIndex((r) => r.name === run.name);
    if (same >= 0) state.runs[same] = run; else state.runs.push(run);
    state.shown = state.runs.indexOf(run);
    $('runInfo').textContent = `${run.name}: ${Math.round(run.ms)} ms per frame on ${det.backend}`;
    $('export').disabled = false;
  } catch (err) {
    $('runInfo').textContent = err.message;
    console.error(err);
  } finally {
    progress(null);
    state.busy = false; $('run').disabled = false;
    renderAll();
  }
});

// ---------- scoring ----------

const hitAt = (run, i, thr) => run.boxes[i].some((b) => b.score >= thr);

function score(run, thr) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < state.frames.length; i++) {
    const hit = hitAt(run, i, thr), truth = state.marks.has(i);
    if (hit && truth) tp++; else if (hit) fp++; else if (truth) fn++; else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

function bestThresholds(run) {
  let best = { thr: null, f1: -1 }, recall90 = null;
  for (let thr = 0.05; thr <= 0.901; thr += 0.05) {
    const s = score(run, thr);
    if (s.f1 >= best.f1) best = { thr, f1: s.f1 }; // ties: prefer the higher threshold
    if (s.recall !== null && s.recall >= 0.9) recall90 = thr; // highest thr still at 90% recall
  }
  return { best, recall90 };
}

$('thr').addEventListener('input', (e) => {
  state.thr = Number(e.target.value);
  $('thrVal').textContent = state.thr.toFixed(2);
  renderResults(); renderFrames(); if (state.open >= 0) drawViewer();
});

// ---------- marks (saved per clip in this browser) ----------

const markKey = () => state.file && `test.marks:${state.file.name}:${state.file.size}:${state.fps}`;
function loadMarks() {
  state.marks = new Set();
  try { JSON.parse(localStorage.getItem(markKey()) || '[]').forEach((i) => state.marks.add(i)); } catch {}
}
function saveMarks() {
  try { localStorage.setItem(markKey(), JSON.stringify([...state.marks])); } catch {}
}
function toggleMark(i) {
  if (state.marks.has(i)) state.marks.delete(i); else state.marks.add(i);
  saveMarks(); renderAll();
}
$('clearLabels').addEventListener('click', () => {
  if (!state.marks.size || !confirm('Clear all marks for this clip?')) return;
  state.marks.clear(); saveMarks(); renderAll();
});

// ---------- rendering ----------

function renderAll() { renderResults(); renderFrames(); if (state.open >= 0) drawViewer(); }

const pct = (v) => (v === null ? '–' : `${Math.round(v * 100)}%`);

function renderResults() {
  $('labelCount').textContent = `${state.marks.size} of ${state.frames.length} frames marked as pothole`;
  if (!state.runs.length) { $('results').innerHTML = ''; return; }
  const marked = state.marks.size > 0;
  const stat = (label, value, cls = '') => `<div class="stat ${cls}"><span>${label}</span><b>${value}</b></div>`;
  $('results').innerHTML = state.runs.map((r, k) => {
    const s = score(r, state.thr);
    const bt = marked ? bestThresholds(r) : null;
    return `<label class="run ${k === state.shown ? 'on' : ''}">
      <input type="radio" name="shown" value="${k}" ${k === state.shown ? 'checked' : ''}>
      <div class="run-head"><div class="model">${esc(r.name)}</div>
        <div class="muted small">${Math.round(r.ms)} ms/frame · ${r.backend}${bt ? ` · best threshold ${bt.best.thr?.toFixed(2)} · keeps 90% recall up to ${bt.recall90?.toFixed(2) ?? '–'}` : ''}</div></div>
      <div class="stats">
        ${stat('Boxed', s.tp + s.fp)}
        ${marked ? stat('Hits', s.tp, 'good') + stat('Misses', s.fn, 'miss') + stat('False', s.fp, 'bad') + stat('Recall', pct(s.recall)) + stat('Precision', pct(s.precision)) : ''}
      </div>
    </label>`;
  }).join('') + (marked ? '' : '<p class="muted small">Mark frames with real potholes to get hits, misses and recall.</p>');
  document.querySelectorAll('input[name=shown]').forEach((el) =>
    el.addEventListener('change', () => { state.shown = Number(el.value); renderAll(); }));
}

function renderFrames() {
  const root = $('frames');
  if (!state.frames.length) return;
  const run = state.runs[state.shown];
  const marked = state.marks.size > 0;
  root.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  state.frames.forEach((f, i) => {
    const hit = run ? hitAt(run, i, state.thr) : false;
    const truth = state.marks.has(i);
    const verdict = !run || !marked ? '' : hit && truth ? 'tp' : hit ? 'fp' : truth ? 'fn' : '';
    const cell = document.createElement('button');
    cell.className = `frame ${verdict} ${truth ? 'truth' : ''} ${hit ? 'hit' : ''}`;
    const c = document.createElement('canvas');
    c.width = f.thumb.width; c.height = f.thumb.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(f.thumb, 0, 0);
    if (run) drawBoxes(ctx, run.boxes[i], c.width / video.videoWidth, 2);
    const top = run && run.boxes[i][0] ? run.boxes[i][0].score : null;
    const tag = { tp: 'hit', fp: 'false box', fn: 'missed' }[verdict] || (truth ? 'pothole' : '');
    cell.append(c);
    cell.insertAdjacentHTML('beforeend', `<span class="meta">${fmtTime(f.t)}${top !== null ? ` · ${floor2(top)}` : ''}</span>${tag ? `<span class="tag ${verdict}">${tag}</span>` : ''}`);
    cell.addEventListener('click', () => openViewer(i));
    grid.append(cell);
  });
  root.append(grid);
}

function drawBoxes(ctx, boxes, s, line) {
  for (const b of boxes) {
    if (b.score < state.thr) continue;
    ctx.strokeStyle = '#f2c230'; ctx.lineWidth = line;
    ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
    if (line > 2) {
      ctx.font = '600 20px "IBM Plex Mono", monospace';
      const label = floor2(b.score);
      ctx.fillStyle = '#f2c230';
      ctx.fillRect(b.x * s, b.y * s - 26, ctx.measureText(label).width + 12, 26);
      ctx.fillStyle = '#0f0f10';
      ctx.fillText(label, b.x * s + 6, b.y * s - 6);
    }
  }
}

// ---------- big viewer ----------

async function openViewer(i) {
  state.open = i;
  $('viewer').hidden = false;
  await drawViewer();
}
async function drawViewer() {
  const i = state.open, f = state.frames[i];
  if (!state.busy) await seek(f.t);
  const big = $('big');
  big.width = video.videoWidth; big.height = video.videoHeight;
  const ctx = big.getContext('2d');
  if (!state.busy) ctx.drawImage(video, 0, 0); else ctx.drawImage(f.thumb, 0, 0, big.width, big.height);
  const run = state.runs[state.shown];
  if (run) drawBoxes(ctx, run.boxes[i], 1, Math.max(3, big.width / 400));
  const truth = state.marks.has(i);
  $('mark').textContent = truth ? 'Marked: pothole (P to unmark)' : 'Pothole here (P)';
  $('mark').classList.toggle('on', truth);
  $('viewerInfo').textContent = `Frame ${i + 1} of ${state.frames.length} · ${fmtTime(f.t)}`;
}
function move(d) {
  if (state.open < 0) return;
  state.open = Math.max(0, Math.min(state.frames.length - 1, state.open + d));
  drawViewer();
}
function closeViewer() { state.open = -1; $('viewer').hidden = true; }
$('prev').addEventListener('click', () => move(-1));
$('next').addEventListener('click', () => move(1));
$('mark').addEventListener('click', () => toggleMark(state.open));
$('close').addEventListener('click', closeViewer);
$('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
document.addEventListener('keydown', (e) => {
  if (state.open < 0) return;
  if (e.key === 'ArrowLeft') move(-1);
  else if (e.key === 'ArrowRight') move(1);
  else if (e.key === 'p' || e.key === 'P') toggleMark(state.open);
  else if (e.key === 'Escape') closeViewer();
  else return;
  e.preventDefault();
});

// ---------- export ----------

$('export').addEventListener('click', () => {
  const out = {
    video: state.file?.name, fps: state.fps, threshold: state.thr,
    frames: state.frames.map((f, i) => ({ i, t: +f.t.toFixed(3), pothole: state.marks.has(i) })),
    runs: state.runs.map((r) => ({
      model: r.name, crop: r.crop, ms_per_frame: +r.ms.toFixed(1), backend: r.backend,
      score_at_threshold: score(r, state.thr),
      boxes: r.boxes.map((bs) => bs.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), score: +b.score.toFixed(3) }))),
    })),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
  a.download = `${(state.file?.name || 'clip').replace(/\.[^.]+$/, '')}-model-test.json`;
  a.click();
});

// ---------- bits ----------

function progress(v) {
  const p = document.querySelector('.progress');
  p.hidden = v === null;
  if (v !== null) $('bar').style.width = `${Math.round(v * 100)}%`;
}
// Round DOWN for display so a box shown as 0.35 really is >= 0.35.
function floor2(v) { return (Math.floor(v * 100) / 100).toFixed(2); }
function fmtTime(s) { const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
