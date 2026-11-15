// Validates a Detection (shared/CONTRACTS.md v4, shared/schema/detection.schema.json).
// Self-contained (no imports) so services/api/tests can run it with plain `node --test`.

export type Verdict = 'pothole' | 'shadow' | 'patch' | 'unverified';

export interface Detection {
  detection_id: string;
  source: 'live' | 'drive';
  lat: number;
  lon: number;
  captured_at: string; // normalised to ISO UTC
  confidence: number;
  bbox: [number, number, number, number] | null;
  image_url: string;
  verdict: Verdict;
  verdict_reason: string | null;
  camera: Camera | null; // v4, optional: which model/camera produced it
}
export type Camera = 'phone' | 'dashcam';

export const MAX_BATCH = 500;
const VERDICTS = ['pothole', 'shadow', 'patch', 'unverified'];
const SOURCES = ['live', 'drive'];
const CAMERAS = ['phone', 'dashcam'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Returns a clean Detection, or an error message naming the bad field. */
export function validateDetection(raw: unknown): Detection | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'detection must be an object';
  const d = raw as Record<string, unknown>;

  if (typeof d.detection_id !== 'string' || !d.detection_id.trim() || d.detection_id.length > 128)
    return 'detection_id must be a non-empty string (max 128 chars)';
  if (!SOURCES.includes(d.source as string)) return `source must be one of ${SOURCES.join(', ')}`;
  if (!isNum(d.lat) || d.lat < -90 || d.lat > 90) return 'lat must be a number in [-90, 90]';
  if (!isNum(d.lon) || d.lon < -180 || d.lon > 180) return 'lon must be a number in [-180, 180]';
  if (typeof d.captured_at !== 'string' || Number.isNaN(Date.parse(d.captured_at)))
    return 'captured_at must be an ISO 8601 date-time string';
  if (!isNum(d.confidence) || d.confidence < 0 || d.confidence > 1)
    return 'confidence must be a number in [0, 1]';
  if (d.bbox != null && !(Array.isArray(d.bbox) && d.bbox.length === 4 && d.bbox.every(isNum)))
    return 'bbox must be [x, y, w, h] (4 numbers) or omitted';
  if (typeof d.image_url !== 'string' || !d.image_url.trim()) return 'image_url must be a non-empty string';
  if (!VERDICTS.includes(d.verdict as string)) return `verdict must be one of ${VERDICTS.join(', ')}`;
  if (d.verdict_reason != null && typeof d.verdict_reason !== 'string')
    return 'verdict_reason must be a string or null';
  if (d.camera != null && !CAMERAS.includes(d.camera as string))
    return `camera must be one of ${CAMERAS.join(', ')} or omitted`;

  return {
    detection_id: d.detection_id.trim(),
    source: d.source as Detection['source'],
    lat: d.lat,
    lon: d.lon,
    captured_at: new Date(d.captured_at).toISOString(),
    confidence: d.confidence,
    bbox: (d.bbox as Detection['bbox']) ?? null,
    image_url: d.image_url,
    verdict: d.verdict as Verdict,
    verdict_reason: (d.verdict_reason as string | null) ?? null,
    camera: (d.camera as Camera | null) ?? null,
  };
}

/**
 * Accepts `Detection` or `{ detections: Detection[] }`. Returns the clean list
 * (duplicate detection_ids in one batch: last one wins) or an error message.
 */
export function parseDetectionsBody(body: unknown): Detection[] | string {
  const isBatch = !!body && typeof body === 'object' && 'detections' in (body as object);
  const items = isBatch ? (body as { detections: unknown }).detections : [body];
  if (!Array.isArray(items)) return '"detections" must be an array';
  if (items.length === 0) return '"detections" is empty';
  if (items.length > MAX_BATCH) return `at most ${MAX_BATCH} detections per request`;

  const byId = new Map<string, Detection>();
  for (let i = 0; i < items.length; i++) {
    const r = validateDetection(items[i]);
    if (typeof r === 'string') return isBatch ? `detections[${i}]: ${r}` : r;
    byId.set(r.detection_id, r);
  }
  return [...byId.values()];
}
