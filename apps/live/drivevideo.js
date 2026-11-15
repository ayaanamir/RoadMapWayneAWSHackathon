// Drive video on the report page: play the drive's recording next to the sightings,
// and jump to the moment of each sighting.
//
// Where the video comes from:
//   - ?video=<url>       a copy hosted on R2 (apps/live/tools/upload_model.py --folder videos)
//     &start=<ms|iso>    when the recording started; otherwise read from the file name
//   - "Choose video"     the recorder's files straight from the phone or laptop. Pick the
//                        .mp4/.webm, and its .json sidecar too for the exact start time.
//
// The recorder names files drive_<UTC stamp>_seg<N>.<ext>, a new file every 5 minutes,
// so the start time can be worked out from the name when there is no sidecar.

const SEGMENT_MS = 5 * 60_000; // same as recorder.js
const $ = (id) => document.getElementById(id);

let startMs = null; // UTC ms of the video's first frame, if known

// "drive_20261114T221530Z_seg2.mp4" → start of segment 2.
function startFromName(name) {
  const m = /drive_(\d{8}T\d{6}Z)_seg(\d+)/.exec(name || "");
  if (!m) return null;
  const s = m[1];
  const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
  return t + (Number(m[2]) - 1) * SEGMENT_MS;
}

function parseStart(v) {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Show a "Play at m:ss" button on every card whose sighting falls inside the video.
export function syncSeekButtons() {
  const v = $("drive-video");
  // Chrome's recorded .webm files report an unknown (Infinity) length: assume a full segment.
  const dur = !v || !v.src ? null : Number.isFinite(v.duration) ? v.duration : SEGMENT_MS / 1000;
  for (const b of document.querySelectorAll("button.seek")) {
    const at = startMs != null && dur ? (Date.parse(b.dataset.t) - startMs) / 1000 : null;
    const ok = at != null && at >= 0 && at <= dur;
    b.hidden = !ok;
    if (ok) {
      b.dataset.at = String(Math.max(0, at - 2)); // 2 s of run-up before the sighting
      b.textContent = `▶ Play at ${clock(at)}`;
    }
  }
}

function load(src, name, start) {
  const v = $("drive-video");
  startMs = start ?? startFromName(name);
  v.src = src;
  v.hidden = false;
  $("video-note").textContent = startMs != null
    ? `Recording started ${new Date(startMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/Detroit" })}. Tap “Play at” on a sighting to jump to it.`
    : "Start time unknown, so sightings can't be matched to the video. Choose the .json file that came with it too.";
  v.addEventListener("loadedmetadata", syncSeekButtons, { once: true });
}

export function initDriveVideo() {
  const params = new URLSearchParams(location.search);
  const url = params.get("video");
  if (url) load(url, decodeURIComponent(url.split("/").pop() || ""), parseStart(params.get("start")));

  $("video-file").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    const vid = files.find((f) => f.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(f.name));
    const side = files.find((f) => f.name.endsWith(".json"));
    if (!vid) {
      $("video-note").textContent = "No video in what you picked. Choose the .mp4 or .webm file.";
      return;
    }
    let start = null;
    if (side) {
      try { start = JSON.parse(await side.text()).start_utc_ms ?? null; } catch { /* fall back to the name */ }
    }
    load(URL.createObjectURL(vid), vid.name, start);
  });

  // Cards are redrawn by filters, so listen on the list itself.
  $("cards").addEventListener("click", (e) => {
    const b = e.target.closest("button.seek");
    if (!b) return;
    const v = $("drive-video");
    v.currentTime = Number(b.dataset.at);
    v.play().catch(() => {});
    v.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
