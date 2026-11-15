// Drive log: everything the drive report needs, kept on the phone (localStorage).
//
//   - the route: a GPS point every few seconds
//   - every sighting the phone sent: time, place, confidence, photo URL, and the
//     server's vision check verdict (pothole / patch / shadow)
//
// The report page (/apps/live/report.html) reads it back and adds the city's earlier
// reports from GET /api/potholes. No video and no laptop needed.
//
// A new log starts when the camera starts, unless the last one was active in the last
// 15 minutes (page reloaded mid-drive): then it carries on.

const KEY = "live.drivelog";
const RESUME_MS = 15 * 60_000;
const FIX_EVERY_MS = 3000;      // one route point every 3 s is plenty for a map line
const MAX_FIXES = 6000;         // about 5 hours

export class DriveLog {
  constructor() {
    this.log = DriveLog.load();
    this.wakeLock = null;
  }

  static load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch {
      return null;
    }
  }

  start() {
    const now = Date.now();
    const last = this.log && (this.log.updated || 0);
    if (!this.log || now - last > RESUME_MS) {
      this.log = { started: new Date(now).toISOString(), updated: now, fixes: [], sightings: [] };
    }
    this.save();
    this.keepAwake();
  }

  // Keep the screen on while the camera runs (the phone is on the windshield).
  async keepAwake() {
    try {
      if (!("wakeLock" in navigator) || this.wakeLock) return;
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => { this.wakeLock = null; });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.keepAwake();
      }, { once: true });
    } catch { /* not allowed here: the screen may sleep, nothing else breaks */ }
  }

  addFix(pos) {
    if (!this.log) return;
    const f = this.log.fixes;
    const t = pos.timestamp;
    if (f.length && t - f[f.length - 1][0] < FIX_EVERY_MS) return;
    f.push([t, +pos.coords.latitude.toFixed(6), +pos.coords.longitude.toFixed(6)]);
    if (f.length > MAX_FIXES) f.shift();
    this.save();
  }

  addSighting(detection, verdict) {
    if (!this.log) return;
    this.log.sightings.push({
      id: detection.detection_id,
      t: detection.captured_at,
      lat: detection.lat,
      lon: detection.lon,
      conf: detection.confidence,
      bbox: detection.bbox,
      img: detection.image_url,
      camera: detection.camera,
      verdict: verdict || "unverified",
    });
    this.save();
  }

  get count() {
    return this.log ? this.log.sightings.length : 0;
  }

  save() {
    this.log.updated = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(this.log));
    } catch { /* storage full or blocked: the live page keeps working */ }
  }
}
