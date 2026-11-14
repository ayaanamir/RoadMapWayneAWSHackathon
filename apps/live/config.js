// Settings for the live page. Most of these can be changed with URL parameters,
// so you can test without editing code. Example:
//   /live?model=https://example.com/pothole.onnx&ep=wasm&conf=0.4

const params = new URLSearchParams(window.location.search);

// Version of ONNX Runtime Web loaded in index.html. Keep both in sync.
export const ORT_VERSION = "1.20.1";
export const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// Where the model file lives.
// Default: a local copy for testing (apps/live/model/ is not committed to git).
// Later (#39) this will point at the pothole model on R2:
//   <R2_PUBLIC_URL>/models/pothole.onnx
export const MODEL_URL = params.get("model") || "/apps/live/model/yolo11n.onnx";

// Which engine runs the model: "webgpu", "wasm", or "auto" (try WebGPU, then WASM).
export const BACKEND = params.get("ep") || "auto";

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
