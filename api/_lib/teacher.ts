// Teacher labels for training data: a large vision model (via OpenRouter) draws pothole boxes on a
// dash-cam frame and names the lookalikes (manhole, patch, shadow…). Humans then confirm at /label.
// Same prompt and box format as pipeline/autolabel/teacher_label.py — keep them in step.
// Self-contained (no imports) so it can be unit-tested with plain `node --test`.

export type NBox = { x: number; y: number; w: number; h: number }; // normalised, top-left origin
export interface Teacher {
  potholes: (NBox & { conf: number; note: string })[];
  lookalikes: (NBox & { kind: string })[];
  road_visible: boolean;
}

// ~20x cheaper than gemini-4-carbon and natively trained on box_2d detection. Override with TEACHER_MODEL.
export const TEACHER_MODEL_DEFAULT = 'google/gemini-2.5-flash-lite';

export const TEACHER_PROMPT = `You label dash-cam frames from Detroit streets to train a pothole detector.
Find every POTHOLE: an open hole or broken-out depression in the road surface with edges and depth,
of ANY size, including small and distant ones. NOT potholes (list them as lookalikes instead):
patched or filled areas, manhole and drain covers, shadows, puddles, stains, cracks without a hole,
road markings, speed bumps, anything off the road (walls, siding, cars). Be strict.

Answer with ONLY this JSON:
{"potholes":[{"box_2d":[ymin,xmin,ymax,xmax],"confidence":0.0,"note":"short reason"}],
 "lookalikes":[{"box_2d":[ymin,xmin,ymax,xmax],"kind":"manhole|patch|shadow|crack|puddle|siding|other"}],
 "road_visible": true}
box_2d values are integers normalised to 0-1000 (ymin, xmin, ymax, xmax). confidence is 0-1.
Use an empty "potholes" list if there is none. Set road_visible false if no road surface is visible.`;

const KINDS = new Set(['manhole', 'patch', 'shadow', 'crack', 'puddle', 'siding', 'other']);

/** box_2d [ymin,xmin,ymax,xmax] in 0-1000 → normalised top-left box, or null if unusable. */
export function fromBox2d(b: unknown): NBox | null {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const c = (v: number) => Math.min(1000, Math.max(0, v)) / 1000;
  const [y1, y2] = [c(b[0]), c(b[2])].sort((p, q) => p - q);
  const [x1, x2] = [c(b[1]), c(b[3])].sort((p, q) => p - q);
  if (x2 - x1 < 0.004 || y2 - y1 < 0.004) return null; // ~3 px on a 720p frame: noise
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: r(x1), y: r(y1), w: r(x2 - x1), h: r(y2 - y1) };
}

/** Pull the teacher JSON out of a model reply (code fences / prose around it are fine). */
export function parseTeacher(text: string): Teacher | null {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let obj: any;
  try {
    obj = JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const potholes = (Array.isArray(obj.potholes) ? obj.potholes : []).flatMap((p: any) => {
    const b = fromBox2d(p?.box_2d);
    if (!b) return [];
    const conf = Number(p?.confidence);
    return [{ ...b, conf: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5, note: String(p?.note ?? '').slice(0, 200) }];
  });
  const lookalikes = (Array.isArray(obj.lookalikes) ? obj.lookalikes : []).flatMap((l: any) => {
    const b = fromBox2d(l?.box_2d);
    if (!b) return [];
    const kind = String(l?.kind ?? 'other').toLowerCase();
    return [{ ...b, kind: KINDS.has(kind) ? kind : 'other' }];
  });
  return { potholes, lookalikes, road_visible: obj.road_visible !== false };
}

/** One teacher call. Throws with a short message on failure (stored as teacher_error). */
export async function teach(
  imageUrl: string,
  opts: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number },
): Promise<Teacher> {
  const res = await fetch(`${opts.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      max_tokens: 800,
      reasoning: { enabled: false }, // no billed "thinking" tokens: this is a perception task
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: TEACHER_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as any;
  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const parsed = parseTeacher(text);
  if (!parsed) throw new Error(`unparseable reply: ${text.slice(0, 160)}`);
  return parsed;
}
