// Drive recording for the footage pipeline: the raw camera as video files, plus a GPS
// track, so every frame can be put on the map later.
//
// What comes out of one drive (all named after the UTC time the drive started):
//   drive_20261114T221530Z_seg1.mp4    video, a new file every 5 minutes
//   drive_20261114T221530Z_seg1.json   when that file started and ended, size, fps
//   drive_20261114T221530Z.gpx         every GPS fix of the drive, with its time
//
// The pipeline works out each frame's time as start_utc_ms + frame_index / fps and
// looks up the place in the GPX. So the JSON field names are a contract with
// pipeline/ (Muq's spec in the team chat): keep them as they are.
//
// Nothing here is sent to the API. Files are saved on the phone (Files app on iPhone).

import { SEGMENT_MS } from "./config.js";

// First format the browser can record: iPhone Safari does mp4, Chrome does webm.
const FORMATS = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
const BITRATE = 4_000_000;     // about 4 Mbps: about 150 MB per 5 minutes
const KEEP_IN_MEMORY = 3;      // newest videos kept for the Save button; older ones are dropped
const LOG_KEY = "live.drive";  // where the GPS log is kept in case the page crashes
const LOG_SAVE_MS = 10_000;

export class DriveRecorder {
  // onChange(state) is called whenever something the page shows has changed.
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.recording = false;
    this.stream = null;
    this.recorder = null;
    this.driveStart = "";      // UTC stamp for the file names, e.g. 20261114T221530Z
    this.startedAt = 0;        // Date.now() when the drive started
    this.segmentNumber = 0;
    this.segments = [];        // finished videos: { name, url, blob?, saved }
    this.fixes = [];           // GPS track
    this.segmentTimer = null;
    this.logTimer = null;
    this.wakeLock = null;
    this.problem = "";
    document.addEventListener("visibilitychange", () => this.keepScreenOn());
  }

  static supported() {
    return typeof MediaRecorder !== "undefined" && FORMATS.some((f) => MediaRecorder.isTypeSupported(f));
  }

  // Start a drive on this camera stream.
  start(stream) {
    if (this.recording) return;
    if (!DriveRecorder.supported()) {
      this.problem = "This browser cannot record video";
      this.changed();
      return;
    }
    this.stream = stream;
    this.recording = true;
    this.problem = "";
    this.startedAt = Date.now();
    this.driveStart = utcStamp(this.startedAt);
    this.segmentNumber = 0;
    this.fixes = [];
    this.startSegment();
    this.logTimer = setInterval(() => this.saveLog(), LOG_SAVE_MS);
    this.keepScreenOn();
    this.changed();
  }

  // End the drive: finish the current video, then save the GPS track.
  stop() {
    if (!this.recording) return;
    this.recording = false;
    clearTimeout(this.segmentTimer);
    clearInterval(this.logTimer);
    this.recorder?.stop(); // its onstop saves the video and then the GPX (last: true)
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.changed();
  }

  // Add one GPS reading (from reporter.js, which already follows the location).
  addFix(pos) {
    if (!this.recording) return;
    const t = new Date(pos.timestamp).toISOString();
    if (this.fixes.length && this.fixes[this.fixes.length - 1].t === t) return; // same fix again
    const c = pos.coords;
    this.fixes.push({
      t, lat: c.latitude, lon: c.longitude,
      accuracy_m: round(c.accuracy, 1), speed: c.speed, heading: c.heading,
    });
    this.changed();
  }

  // ---- Video ----

  startSegment() {
    const mime = FORMATS.find((f) => MediaRecorder.isTypeSupported(f));
    const recorder = new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
    const number = ++this.segmentNumber;
    const chunks = [];
    const info = { start_utc_ms: 0, end_utc_ms: 0 };

    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstart = () => { info.start_utc_ms = Date.now(); };
    recorder.onerror = (e) => {
      console.error("[live] recorder error:", e.error || e);
      this.problem = "Recording stopped";
      this.changed();
    };
    recorder.onstop = () => {
      info.end_utc_ms = Date.now();
      const last = recorder === this.lastRecorder;
      this.finishSegment(number, recorder.mimeType || mime, chunks, info);
      if (last) this.finishDrive();
    };
    recorder.start(1000); // a chunk every second, so a crash loses at most a second
    this.recorder = recorder;
    this.lastRecorder = recorder;

    // Every SEGMENT_MS: start the next file first, then close this one, so the gap is tiny.
    this.segmentTimer = setTimeout(() => {
      if (!this.recording) return;
      this.startSegment();
      recorder.stop();
    }, SEGMENT_MS);
  }

  finishSegment(number, mime, chunks, info) {
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const base = `drive_${this.driveStart}_seg${number}`;
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    const track = this.stream.getVideoTracks()[0];
    const s = track?.getSettings() || {};

    // Sidecar for the pipeline. Field names agreed with pipeline/, do not rename.
    const sidecar = {
      file: `${base}.${ext}`,
      start_utc_ms: info.start_utc_ms,
      end_utc_ms: info.end_utc_ms,
      mime,
      width: s.width || null,
      height: s.height || null,
      fps: s.frameRate || null,
      user_agent: navigator.userAgent,
    };

    const video = { name: sidecar.file, url: URL.createObjectURL(blob), size: blob.size };
    const json = jsonFile(`${base}.json`, sidecar);
    this.segments.push(video, json);
    download(video);
    download(json);

    // Phones run out of memory fast with video, so only the newest few stay savable.
    const videos = this.segments.filter((f) => f.name.endsWith(ext));
    for (const old of videos.slice(0, -KEEP_IN_MEMORY)) {
      if (old.url) URL.revokeObjectURL(old.url);
      old.url = null;
    }

    // The GPS track so far, after every file (the last one is saved by finishDrive).
    if (this.recording) this.saveGpx();
    this.changed();
  }

  finishDrive() {
    this.saveGpx();
    DriveRecorder.clearLeftover(); // ended cleanly, nothing to rescue next time
    this.changed();
  }

  // ---- GPS track ----

  saveGpx() {
    const name = `drive_${this.driveStart}.gpx`;
    const file = { name, url: URL.createObjectURL(new Blob([toGpx(this.fixes, name)], { type: "application/gpx+xml" })) };
    // One GPX in the list: replace the older copy.
    const old = this.segments.find((f) => f.name === name);
    if (old) {
      URL.revokeObjectURL(old.url);
      Object.assign(old, file);
    } else {
      this.segments.push(file);
    }
    download(file);
  }

  // Keep the track in the phone's storage, so a crash or reload does not lose it.
  saveLog() {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify({ driveStart: this.driveStart, fixes: this.fixes }));
    } catch {
      // Storage full or blocked: the GPX downloads still have the track.
    }
  }

  // A track left over from a drive that did not end cleanly (page closed, crash).
  static leftoverGpx() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOG_KEY) || "null");
      if (!saved?.fixes?.length) return null;
      const name = `drive_${saved.driveStart}.gpx`;
      return { name, count: saved.fixes.length, url: URL.createObjectURL(new Blob([toGpx(saved.fixes, name)], { type: "application/gpx+xml" })) };
    } catch {
      return null;
    }
  }

  static clearLeftover() {
    try { localStorage.removeItem(LOG_KEY); } catch { /* blocked */ }
  }

  // ---- Screen ----

  async keepScreenOn() {
    if (!this.recording || document.visibilityState !== "visible" || !navigator.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch (err) {
      console.warn("[live] screen may turn off:", err);
    }
  }

  // What the page shows.
  state() {
    const last = this.fixes[this.fixes.length - 1];
    return {
      recording: this.recording,
      elapsedMs: this.recording ? Date.now() - this.startedAt : 0,
      clips: this.segments.filter((f) => /\.(mp4|webm)$/.test(f.name)).length,
      fixes: this.fixes.length,
      accuracy: last ? last.accuracy_m : null,
      files: this.segments,
      problem: this.problem,
    };
  }

  changed() {
    this.onChange(this.state());
  }
}

// Save a file through a hidden link. Phones may block this without a tap, so the page
// also lists every file with a Save button.
export function download(file) {
  if (!file.url) return;
  const a = document.createElement("a");
  a.href = file.url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  file.saved = true;
}

function jsonFile(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  return { name, url: URL.createObjectURL(blob) };
}

// GPX 1.1, one track, one segment, one point per fix.
function toGpx(fixes, name) {
  const points = fixes.map((f) =>
    `      <trkpt lat="${f.lat.toFixed(7)}" lon="${f.lon.toFixed(7)}"><time>${f.t}</time></trkpt>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Still There live" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name.replace(/\.gpx$/, "")}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

// 1763158530000 -> "20251114T221530Z"
function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function round(n, digits) {
  return n == null ? null : Number(n.toFixed(digits));
}
