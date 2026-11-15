// Sends what the phone sees to the team API, so it shows up on the map.
//
//   #42 GPS: keep the phone's latest location, and send at most once per second.
//   #43 Send: shrink the frame to a JPEG, upload it (POST /api/upload), then send
//       the detection (POST /api/detections) with source "live".
//
// Shapes and paths are from shared/CONTRACTS.md (v4). The phone does not judge
// whether it is really a pothole, so every detection goes out as "unverified".

import {
  API_BASE, SEND_LABELS, DRY_RUN, SEND_EVERY_MS, MODEL_KEY,
  GPS_MAX_AGE_MS, GPS_MAX_ERROR_M, UPLOAD_MAX_WIDTH, UPLOAD_JPEG_QUALITY,
} from "./config.js";

export class Reporter {
  // onChange(state) is called whenever something the page shows has changed.
  // onPosition(pos) gets every GPS reading (the drive recorder logs them).
  constructor(onChange = () => {}, onPosition = () => {}) {
    this.onChange = onChange;
    this.onPosition = onPosition;
    this.position = null;      // latest GPS reading
    this.gpsProblem = "";      // why we have no GPS, if we do not
    this.sending = false;      // a send is in progress
    this.lastSentAt = 0;       // when the last send started (ms)
    this.sentCount = 0;        // how many detections went through
    this.lastMessage = DRY_RUN ? "Practice mode" : "";
    // While recording a drive, say "No signal" when readings stop coming in. Off
    // otherwise: a laptop that is not moving gets few readings and is still fine.
    this.flagStale = false;
    // Color of the message: "good" green, "warn" amber, "bad" red, "quiet" gray, "" normal.
    this.lastTone = DRY_RUN ? "quiet" : "";

    // Reused canvas for making the JPEG.
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
  }

  // Start following the phone's location. Call this right after a tap, because
  // iPhone Safari only asks for permission then.
  startGps() {
    if (!navigator.geolocation) {
      this.gpsProblem = "Not available";
      this.changed();
      return;
    }
    navigator.geolocation.watchPosition(
      (pos) => {
        this.position = pos;
        this.gpsProblem = "";
        this.onPosition(pos);
        this.changed();
      },
      (err) => {
        this.gpsProblem = err.code === err.PERMISSION_DENIED ? "Blocked" : "No signal";
        this.changed();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }, // fresh fixes only, for the drive track,
    );
  }

  // Call after every model run. Sends the strongest matching box, if it is time.
  // `source` is the <video> the boxes were found in; w and h are its size.
  maybeSend(boxes, source, w, h) {
    const wanted = boxes.filter((b) => SEND_LABELS.includes(b.label));
    if (wanted.length === 0) return;
    if (this.sending) return;                                      // one at a time
    if (performance.now() - this.lastSentAt < SEND_EVERY_MS) return; // at most 1 per second

    const gps = this.usableGps();
    if (!gps) {
      this.say("Waiting for GPS", "warn");
      this.changed();
      return;
    }

    const best = wanted.reduce((a, b) => (b.score > a.score ? b : a));
    this.lastSentAt = performance.now();
    this.send(best, source, w, h, gps); // not awaited: the camera keeps going
  }

  // The latest GPS reading, or null if it is missing, too old, or too rough.
  usableGps() {
    const p = this.position;
    if (!p) return null;
    if (Date.now() - p.timestamp > GPS_MAX_AGE_MS) return null;
    if (p.coords.accuracy > GPS_MAX_ERROR_M) return null;
    return { lat: p.coords.latitude, lon: p.coords.longitude };
  }

  async send(box, source, w, h, gps) {
    this.sending = true;
    const capturedAt = new Date().toISOString();
    const id = crypto.randomUUID();

    try {
      // 1. Make the JPEG now, before the camera moves on.
      const { blob, scale } = await this.frameToJpeg(source, w, h);

      // The box in the uploaded image's pixels (the image may be smaller than the camera).
      const bbox = [box.x, box.y, box.w, box.h].map((v) => Math.round(v * scale));

      // 2. Upload the frame.
      const imageUrl = DRY_RUN
        ? `(dry run) ${id}.jpg, ${Math.round(blob.size / 1024)} KB`
        : await uploadFrame(blob, `${id}.jpg`);

      // 3. Send the detection.
      const detection = {
        detection_id: id,
        source: "live",
        // Contract v4: tells the server which vision check to use. The dash-cam model's
        // potholes are small and far away, so they get the dash-cam wording.
        camera: MODEL_KEY === "dashcam" ? "dashcam" : "phone",
        lat: gps.lat,
        lon: gps.lon,
        captured_at: capturedAt,
        confidence: Number(box.score.toFixed(3)),
        bbox,
        image_url: imageUrl,
        verdict: "unverified",
        verdict_reason: null,
      };

      if (DRY_RUN) {
        console.info("[live] dry run, would send:", detection);
        this.say(`Would send, ${Math.round(box.score * 100)}%`, "");
      } else {
        const result = await postDetection(detection);
        this.sentCount += 1;
        // The API answers right away. If it is still checking the photo with the vision
        // model (result.verifying), the pin can show up a few seconds later.
        const pin = result.pothole_ids?.[0];
        this.say(pin ? "On the map" : result.verifying ? "Sent, checking" : "Sent", "good");
      }
    } catch (err) {
      console.error("[live] send failed:", err);
      this.say(`Not sent: ${shortReason(err)}`, "bad");
    } finally {
      this.sending = false;
      this.changed();
    }
  }

  // Copy the current frame into a JPEG no wider than UPLOAD_MAX_WIDTH.
  frameToJpeg(source, w, h) {
    const scale = Math.min(1, UPLOAD_MAX_WIDTH / w);
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    this.ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob ? resolve({ blob, scale }) : reject(new Error("could not make the JPEG"))),
        "image/jpeg",
        UPLOAD_JPEG_QUALITY,
      );
    });
  }

  // What the page shows: GPS state, count, and the last message.
  state() {
    const p = this.position;
    let gps = "waiting";
    let gpsTone = "quiet";
    if (this.gpsProblem) {
      gps = this.gpsProblem;
      gpsTone = this.gpsProblem === "Blocked" ? "bad" : "warn";
    } else if (p && this.flagStale && Date.now() - p.timestamp > 10_000) {
      gps = "No signal"; // last reading is old: tunnel, garage, lost fix
      gpsTone = "warn";
    } else if (p) {
      gps = `±${Math.round(p.coords.accuracy)} m`;
      gpsTone = p.coords.accuracy > GPS_MAX_ERROR_M ? "warn" : ""; // too rough to send
    }
    return {
      gps, gpsTone,
      sent: this.sentCount,
      message: this.lastMessage, messageTone: this.lastTone,
    };
  }

  say(message, tone) {
    this.lastMessage = message;
    this.lastTone = tone;
  }

  changed() {
    this.onChange(this.state());
  }
}

// POST /api/upload: raw JPEG in, { image_url } out.
async function uploadFrame(blob, name) {
  const res = await fetch(`${API_BASE}/api/upload?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  const data = await readJson(res, "upload");
  if (!data.image_url) throw new Error("upload failed");
  return data.image_url;
}

// POST /api/detections: one Detection in, { ok, pothole_ids } out.
// The API ignores repeats of the same detection_id, so one retry is safe.
async function postDetection(detection) {
  const send = () => fetch(`${API_BASE}/api/detections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(detection),
  });
  let res;
  try {
    res = await send();
  } catch {
    res = await send(); // network blip: try once more
  }
  return readJson(res, "detections");
}

// A few words on why a send failed, for the status box. Full error is in the console.
function shortReason(err) {
  if (err instanceof TypeError) return "no connection"; // fetch failed: offline or blocked
  if (/JPEG/.test(err.message)) return "photo failed";
  return err.message;
}

// Turn an API response into JSON, with a readable error if something is off.
async function readJson(res, what) {
  if (res.status === 404) throw new Error("server offline");
  if (!res.ok) throw new Error(`server error ${res.status}`);
  return res.json();
}
