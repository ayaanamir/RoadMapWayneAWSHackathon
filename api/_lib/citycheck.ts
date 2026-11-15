// Small-model check that a city "Potholes" report really is road damage (#133).
// The city's Potholes type also holds sidewalk, curb, debris and bike-lane reports. We read the
// report's SeeClickFix text + photo and ask a small OpenRouter model. Self-contained (no imports)
// so services/api/tests can run parseCheck with `node --test`.

export type CityCheck = { verdict: 'pothole' | 'not_pothole'; reason: string };

export const CITY_CHECK_PROMPT = `You sort Detroit 311 reports that were filed under "Potholes".
Decide if this report is about a pothole or broken road surface where cars drive.

City's current category: {SUMMARY}
Address: {ADDRESS}
Reporter's text: {TEXT}
{PHOTO}
Answer with ONLY this JSON, nothing else:
{"verdict": "pothole" | "not_pothole", "reason": "<one short sentence>"}

- "pothole": a hole, broken or missing asphalt, sinkhole, sunken or buckled pavement in a
  street, alley, intersection, bike lane or driveway entrance.
- "not_pothole": sidewalk, curb, something blocking the road (barrel, debris, trash, cars),
  weeds, lights, signs, flooding, or anything that isn't damage to the driving surface.
If the text is empty or only says pothole/hole and the photo doesn't show something else,
say "pothole".`;

/** Pulls {verdict, reason} out of a model reply. Returns null if it can't. */
export function parseCheck(text: string): CityCheck | null {
  if (!text) return null;
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  let verdict = '';
  let reason = '';
  if (i >= 0 && j > i) {
    try {
      const obj = JSON.parse(text.slice(i, j + 1));
      verdict = String(obj.verdict ?? '').toLowerCase().trim();
      reason = String(obj.reason ?? '').trim();
    } catch {
      /* fall through to the word match */
    }
  }
  if (!verdict) {
    const low = text.toLowerCase();
    verdict = low.includes('not_pothole') ? 'not_pothole' : low.includes('pothole') ? 'pothole' : '';
  }
  if (verdict !== 'pothole' && verdict !== 'not_pothole') return null;
  return { verdict, reason: (reason || verdict).slice(0, 300) };
}

export type ScfIssue = { summary: string; text: string; photo: string | null };

/** SeeClickFix's public record for a report. null if it can't be read; 'busy' if rate-limited. */
export async function scfIssue(issueId: string, base = 'https://seeclickfix.com'): Promise<ScfIssue | null | 'busy'> {
  try {
    const res = await fetch(`${base}/api/v2/issues/${encodeURIComponent(issueId)}`, {
      headers: { 'User-Agent': 'still-there-ingest/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) return 'busy';
    if (!res.ok) {
      console.error('city-check: seeclickfix', issueId, res.status);
      return null;
    }
    const d = (await res.json()) as any;
    return {
      summary: String(d?.summary ?? '').trim(),
      text: String(d?.description ?? '').trim(),
      photo: typeof d?.media?.image_full === 'string' ? d.media.image_full : null,
    };
  } catch (err) {
    console.error('city-check: seeclickfix', issueId, err);
    return null;
  }
}

/** Photo as a data: URL (the model can't always follow SeeClickFix's redirects). null on failure. */
async function photoData(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'still-there-ingest/1.0' }, signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export interface CheckOptions {
  apiKey: string;
  model: string;
  baseUrl?: string; // OpenRouter override for tests
  scfBase?: string; // SeeClickFix override for tests
}

async function ask(prompt: string, image: string | null, opts: CheckOptions): Promise<CityCheck | null> {
  const content: any[] = [{ type: 'text', text: prompt }];
  if (image) content.push({ type: 'image_url', image_url: { url: image } });
  const res = await fetch(`${opts.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ model: opts.model, temperature: 0, max_tokens: 150, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const text = data?.choices?.[0]?.message?.content;
  return parseCheck(typeof text === 'string' ? text : JSON.stringify(text ?? ''));
}

export type CheckResult =
  | ({ kind: 'ok'; photo_url: string | null } & CityCheck)
  | { kind: 'busy' }        // SeeClickFix rate-limited us: nothing spent, try later
  | { kind: 'no_report' }   // SeeClickFix had no readable record: nothing spent
  | { kind: 'model_failed' };

/** Checks one report: SeeClickFix text + photo → model verdict. */
export async function checkReport(issueId: string, address: string, opts: CheckOptions): Promise<CheckResult> {
  const scf = await scfIssue(issueId, opts.scfBase);
  if (scf === 'busy') return { kind: 'busy' };
  if (!scf) return { kind: 'no_report' };
  const image = scf.photo ? await photoData(scf.photo) : null;
  const fill = (withPhoto: boolean) =>
    CITY_CHECK_PROMPT.replace('{SUMMARY}', scf.summary || 'Potholes')
      .replace('{ADDRESS}', address || 'unknown')
      .replace('{TEXT}', scf.text.slice(0, 1500) || '(none)')
      .replace('{PHOTO}', withPhoto ? "The reporter's photo is attached." : 'No photo.');
  // With the photo first; if that call fails, once more on the text alone.
  for (const img of image ? [image, null] : [null]) {
    try {
      const got = await ask(fill(!!img), img, opts);
      if (got) return { kind: 'ok', ...got, photo_url: scf.photo };
    } catch (err) {
      console.error('city-check: model', issueId, err);
    }
  }
  return { kind: 'model_failed' };
}
