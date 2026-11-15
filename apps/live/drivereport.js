// Drive report, on the phone: what this drive saw, checked against the city's records.
//
// In: the drive log the live page kept (drivelog.js, localStorage) and the city's earlier
// pothole reports (GET /api/potholes). Out: headline numbers, a route map, and one card
// per sighting with its photo, the vision check verdict, and the nearest earlier city
// report within NEAR_M (how many reports, when the city closed it).

import { API_BASE } from "./config.js";
import { DriveLog } from "./drivelog.js";

const NEAR_M = 50;    // a sighting this close to a city report counts as "at" it
const PASSED_M = 25;  // a city report this close to the route counts as "driven past"
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tz = { timeZone: "America/Detroit" };
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...tz });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", ...tz });
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const VERDICT = { pothole: "Pothole", patch: "Patched", shadow: "Not a pothole", unverified: "Not checked" };

function meters(a, b, c, d) {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

async function main() {
  const log = DriveLog.load();
  if (!log) {
    $("headline").textContent = "No drive yet";
    $("breakdown").textContent = "Open the camera page, start the camera, and drive. The report fills in as the phone sees potholes.";
    $("map").hidden = true;
    return;
  }

  let potholes = [];
  try {
    const res = await fetch(`${API_BASE}/api/potholes`);
    potholes = (await res.json()).potholes || [];
  } catch {
    $("breakdown").textContent = "Could not load the city's reports (no connection). Showing the drive only.";
  }
  const reported = potholes.filter((p) => p.city_reports?.length);

  const fixes = log.fixes;
  const sightings = log.sightings;
  let dist = 0;
  for (let i = 1; i < fixes.length; i++) dist += meters(fixes[i - 1][1], fixes[i - 1][2], fixes[i][1], fixes[i][2]);
  const startT = fixes[0]?.[0] ?? Date.parse(log.started);
  const endT = fixes.at(-1)?.[0] ?? log.updated;
  const mins = Math.max(0, Math.round((endT - startT) / 60000));

  // Nearest earlier city report for each sighting.
  const rows = sightings.map((s) => {
    let near = null, best = Infinity;
    for (const p of reported) {
      const m = meters(s.lat, s.lon, p.lat, p.lon);
      if (m < best) { best = m; near = p; }
    }
    return { s, near: best <= NEAR_M ? near : null, m: best };
  });

  // City reports the route went past.
  const step = Math.max(1, Math.floor(fixes.length / 1500));
  const route = fixes.filter((_, i) => i % step === 0);
  const passed = reported.filter((p) => route.some((f) => meters(p.lat, p.lon, f[1], f[2]) <= PASSED_M));

  const by = (v) => rows.filter((r) => r.s.verdict === v);
  const confirmed = by("pothole");
  const atPrev = rows.filter((r) => r.near && r.s.verdict !== "shadow");
  const backAfterClose = confirmed.filter((r) => r.near && r.near.city_reports.some((c) => c.closed_at && c.closed_at < r.s.t));
  const seenIds = new Set(atPrev.map((r) => r.near.pothole_id));

  $("when").textContent = `Drive report · ${new Date(startT).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...tz })}`;
  $("headline").textContent = confirmed.length
    ? `${plural(confirmed.length, "pothole")} found${backAfterClose.length ? `, ${backAfterClose.length} the city already closed` : ""}`
    : sightings.length ? "No potholes confirmed yet" : "Nothing seen yet";
  const stats = [
    [`${(dist / 1609.34).toFixed(1)} mi`, `driven in ${mins} min`],
    [String(sightings.length), "sightings by the model"],
    [String(confirmed.length), "confirmed potholes"],
    [String(by("patch").length), "patched spots"],
    [String(atPrev.length), `within ${NEAR_M} m of an earlier city report`],
    [String(backAfterClose.length), "potholes back after the city closed them"],
  ];
  $("stats").innerHTML = stats.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("");
  if (!$("breakdown").textContent) {
    $("breakdown").textContent =
      `Vision check: ${by("pothole").length} pothole, ${by("patch").length} patched, ${by("shadow").length} not a pothole` +
      (by("unverified").length ? `, ${by("unverified").length} not checked` : "") +
      `. The route passed ${plural(passed.length, "spot")} with a city report; we saw damage at ${seenIds.size}.`;
  }

  // Cards: potholes first, then patches, then the rest, each in time order.
  const rank = { pothole: 0, patch: 1, unverified: 2, shadow: 3 };
  const ordered = rows.map((r, i) => ({ ...r, i })).sort((a, b) => (rank[a.s.verdict] ?? 2) - (rank[b.s.verdict] ?? 2) || a.s.t.localeCompare(b.s.t));
  ordered.forEach((r, n) => { r.n = n + 1; });
  let filter = "real";
  const draw = () => {
    const shown = ordered.filter((r) => filter === "all" || r.s.verdict === "pothole" || r.s.verdict === "patch");
    $("cards").innerHTML = shown.length ? shown.map(card).join("")
      : `<p class="empty">${sightings.length ? "No confirmed potholes or patches. Tap “Everything the model saw” to see what it flagged." : "The model has not flagged anything on this drive yet."}</p>`;
    for (const img of document.querySelectorAll(".ph img")) img.addEventListener("load", placeBox, { once: true });
    document.querySelectorAll(".ph img").forEach((img) => img.complete && placeBox({ target: img }));
  };
  for (const b of document.querySelectorAll("#filters button")) {
    b.addEventListener("click", () => {
      filter = b.dataset.f;
      document.querySelectorAll("#filters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      draw();
    });
  }
  draw();
  drawMap(route, ordered, potholes, seenIds);

  $("new-drive").addEventListener("click", () => {
    if (!confirm("Clear this drive's report from the phone and start a new one?")) return;
    try { localStorage.removeItem("live.drivelog"); } catch {}
    location.href = "/live";
  });
}

function card(r) {
  const { s, near, m } = r;
  const img = s.img && s.img.startsWith("http")
    ? `<img src="${esc(s.img)}" alt="Sighting ${r.n}" loading="lazy" data-bbox="${esc((s.bbox || []).join(","))}">`
    : "";
  let prev;
  if (near) {
    const reps = [...near.city_reports].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const lastClose = reps.map((c) => c.closed_at).filter(Boolean).sort().at(-1);
    let line = `<b>${Math.round(m)} m from an earlier city report</b> at ${esc(near.address || "")}: ${plural(reps.length, "report")}, first ${fmtDate(reps[0].created_at)}`;
    if (lastClose) {
      const days = Math.max(0, Math.round((Date.parse(s.t) - Date.parse(lastClose)) / 86400000));
      line += `, closed ${fmtDate(lastClose)}`;
      if (s.verdict === "pothole") line += ` — <b>still there ${days} days later</b>`;
      else if (s.verdict === "patch") line += ` — patched, the repair is holding`;
    }
    const links = reps.filter((c) => c.issue_url).map((c) => `<a href="${esc(c.issue_url)}" target="_blank" rel="noopener">#${esc(c.issue_id)}</a>`).join(" ");
    prev = `<p class="prev">${line}. ${links}</p>`;
  } else {
    prev = `<p class="new">No city report within ${NEAR_M} m.${s.verdict === "pothole" ? " Never reported." : ""}</p>`;
  }
  return `<article class="card" id="s${r.n}">
    <div class="ph">${img}</div>
    <div class="body">
      <div class="top"><span class="num">#${r.n}</span><span class="verdict v-${esc(s.verdict)}">${esc(VERDICT[s.verdict] || s.verdict)}</span>
        <span class="meta">${fmtTime(s.t)} · model ${Math.round(s.conf * 100)}%</span></div>
      ${prev}
    </div>
  </article>`;
}

// Draw the model's box over the photo (bbox is in the uploaded image's pixels).
function placeBox({ target: img }) {
  const b = (img.dataset.bbox || "").split(",").map(Number);
  if (b.length !== 4 || !img.naturalWidth || img.parentElement.querySelector(".box")) return;
  const el = document.createElement("span");
  el.className = "box";
  Object.assign(el.style, {
    left: `${(b[0] / img.naturalWidth) * 100}%`, top: `${(b[1] / img.naturalHeight) * 100}%`,
    width: `${(b[2] / img.naturalWidth) * 100}%`, height: `${(b[3] / img.naturalHeight) * 100}%`,
  });
  img.parentElement.appendChild(el);
}

function drawMap(route, rows, potholes, seenIds) {
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const color = { pothole: css("--pothole"), patch: css("--patch"), shadow: css("--shadow"), unverified: css("--unv") };
  const map = L.map("map", { scrollWheelZoom: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
  const pts = route.map((f) => [f[1], f[2]]);
  const bounds = L.latLngBounds(pts.length ? pts : rows.map((r) => [r.s.lat, r.s.lon]));
  if (pts.length) L.polyline(pts, { color: "#5b8def", weight: 4, opacity: 0.8 }).addTo(map);
  const area = bounds.isValid() ? bounds.pad(0.3) : null;
  for (const p of potholes) {
    if (!p.city_reports?.length || (area && !area.contains([p.lat, p.lon]))) continue;
    const seen = seenIds.has(p.pothole_id);
    L.circleMarker([p.lat, p.lon], { radius: 7, color: "#1d1d1f", weight: seen ? 3.5 : 2, fill: true, fillColor: "#fff", fillOpacity: 0.6 })
      .bindTooltip(`${esc(p.address || "")}: ${plural(p.city_reports.length, "city report")}${seen ? " · seen on this drive" : ""}`).addTo(map);
  }
  for (const r of rows) {
    L.circleMarker([r.s.lat, r.s.lon], { radius: 6, color: "#fff", weight: 1.5, fillColor: color[r.s.verdict] || color.unverified, fillOpacity: 1 })
      .bindTooltip(`#${r.n} ${VERDICT[r.s.verdict] || ""}`)
      .on("click", () => document.getElementById(`s${r.n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }))
      .addTo(map);
  }
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
  else map.setView([42.3314, -83.0458], 13);
}

main();
