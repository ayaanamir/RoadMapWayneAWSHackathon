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

// Where the model file lives. Upload with apps/live/tools/upload_model.py.
// Now: the stock COCO model, as a placeholder.
// Next (#39): change to `${R2_PUBLIC_URL}/models/pothole.onnx`.
// To test a local copy instead: ?model=/apps/live/model/yolo11n.onnx
export const MODEL_URL = params.get("model") || `${R2_PUBLIC_URL}/models/yolo11n.onnx`;

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
export const CONFIDENCE_MIN = Number(params.get("conf") || 0.35);

// When two boxes overlap more than this, keep only the stronger one (0 to 1).
export const OVERLAP_MAX = 0.45;

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
