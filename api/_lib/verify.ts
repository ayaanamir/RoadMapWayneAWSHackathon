// Server-side vision check for `unverified` detections (OpenRouter, OpenAI-compatible).
// The on-device detector proposes; this decides pothole / patch / shadow (= not a pothole).
// Self-contained (no imports) so services/api/tests can run parseVerdict with `node --test`.
//
// Prompt note: the pipeline (Footage) owns verify prompts in pipeline/prompts/. Until one
// exists this is the shared wording; keep both in step if either changes.

export type Checked = { verdict: 'pothole' | 'shadow' | 'patch'; reason: string };

export const VERIFY_PROMPT = `You check road photos from a phone or dash camera in Detroit.
An automatic detector thinks there is a pothole in this photo{BOX}.

Decide what is really there and answer with ONLY this JSON, nothing else:
{"verdict": "pothole" | "patch" | "shadow", "reason": "<one short sentence about what you see>"}

- "pothole": a real hole or broken-out depression in the road surface, with edges and depth.
- "patch": a repaired spot (asphalt fill, cold patch, sealed square) with no open hole.
- "shadow": anything else - shadow, puddle, stain, crack without a hole, manhole or drain
  cover, road marking, speed bump, debris, or no road visible.
If you are not sure it is a hole, do not say "pothole".`;

/** Pulls {verdict, reason} out of a model reply. Returns null if it can't. */
export function parseVerdict(text: string): Checked | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let verdict = '';
  let reason = '';
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      verdict = String(obj.verdict ?? '').toLowerCase().trim();
      reason = String(obj.reason ?? '').trim();
    } catch {
      /* fall through to the word match */
    }
  }
  if (!verdict) {
    const m = text.toLowerCase().match(/\b(pothole|patch|shadow)\b/);
    if (!m) return null;
    verdict = m[1];
  }
  if (verdict === 'not_pothole' || verdict === 'none' || verdict === 'other') verdict = 'shadow';
  if (verdict !== 'pothole' && verdict !== 'patch' && verdict !== 'shadow') return null;
  return { verdict, reason: (reason || `Vision check: ${verdict}.`).slice(0, 300) };
}

export interface VerifyOptions {
  apiKey: string;
  model: string;
  baseUrl?: string; // override for tests
  timeoutMs?: number;
}

/** Asks the vision model about one image. Returns null on any failure (stays unverified). */
export async function verifyImage(
  imageUrl: string,
  bbox: number[] | null,
  opts: VerifyOptions,
): Promise<Checked | null> {
  const box = bbox && bbox.length === 4
    ? ` (the detector's box: x=${Math.round(bbox[0])}, y=${Math.round(bbox[1])}, ` +
      `w=${Math.round(bbox[2])}, h=${Math.round(bbox[3])} pixels from the top-left)`
    : '';
  try {
    const res = await fetch(`${opts.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VERIFY_PROMPT.replace('{BOX}', box) },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
      }),
    });
    if (!res.ok) {
      console.error('verify: OpenRouter', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content;
    const parsed = parseVerdict(typeof text === 'string' ? text : JSON.stringify(text ?? ''));
    if (!parsed) console.error('verify: could not parse reply', String(text).slice(0, 300));
    return parsed;
  } catch (err) {
    console.error('verify: request failed', err);
    return null;
  }
}
