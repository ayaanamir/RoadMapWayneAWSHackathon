// Settings for the live page. Most of these can be changed with URL parameters,
// so you can test without editing code. Example:
//   /live?model=https://example.com/pothole.onnx&ep=wasm&conf=0.4

const params = new URLSearchParams(window.location.search);

// Version of ONNX Runtime Web loaded in index.html. Keep both in sync.
export const ORT_VERSION = "1.20.1";
export const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Public address of the team's R2 bucket (same as R2_PUBLIC_URL in .env).
// This is safe to have in code: it is read only. The upload keys stay in .env.
export const R2_PUBLIC_URL = "https://pub-9da122d7960d49de90da1a69cb4fe7f9.r2.dev";

// The pothole models we can switch between. Both are YOLO11n with one class "pothole",
// exported at 640x640. Upload with apps/live/tools/upload_model.py, e.g.
//   python3 apps/live/tools/upload_model.py <file>.onnx --name pothole-dashcam.onnx
//   phone:   Muq's first model, trained on close-up photos (#39).
//   dashcam: trained on dashcam footage, better from a moving car.
//   url:  if set, load from this site (Vercel serves apps/live/model/*.onnx) instead of R2.
//   conf: the threshold the Detroit test set picked for this model (?conf= still overrides).
export const MODELS = {
  phone: { name: "Phone model", short: "Phone", file: "pothole.onnx", conf: 0.35 },
  dashcam: {
    name: "Dashcam model", short: "Dashcam", file: "pothole-dashcam.onnx",
    url: "/apps/live/model/pothole-dashcam.onnx", // swap the file to ship a new model (one PR)
    conf: 0.40,
  },
};

// Which model to use. Order of choice:
//   1. ?m=phone or ?m=dashcam in the URL
//   2. what was picked last time on this phone
//   3. phone
const MODEL_MEMORY_KEY = "live.model";
const pickedModel = params.get("m") || readMemory(MODEL_MEMORY_KEY);
export const MODEL_KEY = MODELS[pickedModel] ? pickedModel : "phone";

// ?model=<full URL> loads any other .onnx file instead (for testing). The old stock
// model is still in the bucket: ?model=<R2 URL>/models/yolo11n.onnx
export const MODEL_FROM_URL = params.get("model");
export const MODEL_URL = MODEL_FROM_URL || modelUrl(MODEL_KEY);

export function modelUrl(key) {
  return MODELS[key].url || `${R2_PUBLIC_URL}/models/${MODELS[key].file}`;
}

// Remember a model for this phone (same idea as rememberBackend below).
export function rememberModel(key) {
  try {
    localStorage.setItem(MODEL_MEMORY_KEY, key);
  } catch {
    // Storage blocked: the page still works, it just will not remember.
  }
}

// Which engine runs the model: "webgpu", "wasm", or "auto" (WebGPU if the browser
// has it, else WASM). Order of choice:
//   1. ?ep= in the URL (for testing)
//   2. what this phone fell back to last time (WebGPU hung here before)
//   3. "auto"
const ENGINE_MEMORY_KEY = "live.engine";
export const BACKEND_FROM_URL = params.get("ep");
export const REMEMBERED_BACKEND = readMemory(ENGINE_MEMORY_KEY);
export const BACKEND = BACKEND_FROM_URL || REMEMBERED_BACKEND || "auto";

// Remember an engine for this phone (or clear it with null).
// Wrapped in try/catch because private browsing can block storage.
export function rememberBackend(backend) {
  try {
    if (backend) localStorage.setItem(ENGINE_MEMORY_KEY, backend);
    else localStorage.removeItem(ENGINE_MEMORY_KEY);
  } catch {
    // Storage blocked: the page still works, it just will not remember.
  }
}

function readMemory(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// The model expects a square image of this size (what it was exported with).
export const INPUT_SIZE = 640;

// Ignore boxes the model is less sure about than this (0 to 1).
// Per model (switching models reloads the page), unless ?conf= is given.
export const CONFIDENCE_MIN = Number(params.get("conf") || MODELS[MODEL_KEY].conf || 0.35);

// When two boxes overlap more than this, keep only the stronger one (0 to 1).
export const OVERLAP_MAX = 0.45;

// ---- Drive recording (recorder.js) ----

// ?rec=1 starts recording as soon as the camera is on (after the Start tap).
export const REC_AUTO = params.get("rec") === "1";

// ?detect=0 records only: no model, nothing sent. For long drives, in case recording
// and the model together make the phone hot or drop frames.
export const DETECT = params.get("detect") !== "0";

// A new video file every this many minutes (iPhone memory). ?seg=1 for quick tests.
export const SEGMENT_MS = Number(params.get("seg") || 5) * 60_000;

// ---- Sending detections to the API (#42, #43) ----

// Where the API lives. Empty = same site as this page (the normal case on Vercel).
// For testing from a laptop: ?api=https://wayneawshackathon.vercel.app
export const API_BASE = (params.get("api") || "").replace(/\/$/, "");

// Only boxes with these labels are sent. The stock COCO model has no "pothole" class,
// so nothing is sent until the pothole model (#39) is in. To try the flow with the
// stock model, use e.g. ?sendlabel=cup together with ?dry (see below).
export const SEND_LABELS = params.get("sendlabel")
  ? params.get("sendlabel").split(",")
  : ["pothole"];

// Dry run (?dry): do everything except the network calls, and show what would be sent.
// Use this for testing so no fake potholes end up in the team database.
export const DRY_RUN = params.has("dry");

// Send at most one detection per this many milliseconds.
export const SEND_EVERY_MS = 1000;

// Do not send if the last GPS reading is older than this, or less accurate than this.
export const GPS_MAX_AGE_MS = 30_000;
export const GPS_MAX_ERROR_M = 100;

// Uploaded frames: at most this wide, at this JPEG quality (contract: under 4 MB).
export const UPLOAD_MAX_WIDTH = 1280;
export const UPLOAD_JPEG_QUALITY = 0.8;

// Class names for the stock COCO model (80 everyday objects). Used only while we
// wait for the pothole model, which has a single class.
export const COCO_LABELS = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
  "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
  "toothbrush",
];

// Pick class names based on how many classes the loaded model has.
export function labelsFor(classCount) {
  if (classCount === 80) return COCO_LABELS;
  if (classCount === 1) return ["pothole"];
  return Array.from({ length: classCount }, (_, i) => `class ${i}`);
}
