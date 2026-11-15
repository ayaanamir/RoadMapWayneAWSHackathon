// POST /api/detections   body: Detection | { detections: Detection[] }
//   → { ok: true, pothole_ids: string[], results: [{ detection_id, pothole_id|null }] }
//
// Contract v3 (shared/CONTRACTS.md):
// - upsert on detection_id (retries are safe; a re-post can upgrade the verdict)
// - join the nearest pothole within 50 m
// - else create a new pothole only if verdict is `pothole`, or it is `unverified` and
//   another pothole/unverified detection is within 50 m (shadow/patch never create one)
// - otherwise keep it with pothole_id = null (stored, not shown)
// - recompute state + last_seen_at via the recompute_pothole() SQL function
// - then, after the response is sent, ask the vision model about up to VERIFY_MAX
//   `unverified` detections that have a real image; store its verdict and re-match
//   (so a confirmed live sighting can create a pin / turn one red). Off if
//   OPENROUTER_API_KEY / OPENROUTER_MODEL are unset or VERIFY_ON_SERVER=0.
// POST /api/detections?verify=only  body: { checks: [{ image_url, bbox }] } (≤ 30, our R2 images)
//   → { ok, model, results: [{ verdict, reason } | null] }. Vision check only; writes nothing.
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { json, preflight } from './_lib/http';
import { waitUntil } from '@vercel/functions';
import { parseDetectionsBody, type Detection } from './_lib/detection';
import { verifyImage } from './_lib/verify';

const MATCH_M = 50;
const VERIFY_MAX = 10; // vision checks per request
const VERIFY_PARALLEL = 3;
const RETRY_STALE = 5;        // older unchecked sightings re-checked per request (heals model outages)
const MAX_ATTEMPTS = 3;       // never pay for the same broken image more than this

/** Server-side vision check is on (key + model set, not switched off). */
const verifyOn = () =>
  !!process.env.OPENROUTER_API_KEY && !!process.env.OPENROUTER_MODEL && process.env.VERIFY_ON_SERVER !== '0';
/** The image is somewhere the vision model can fetch it. */
const checkableUrl = (u: string) => /^https:\/\//.test(u) && !u.includes('.invalid/');
const ADDRESS_M = 100; // borrow the nearest city report's address for new potholes

// Haversine in metres between row aliases a and b, with a cheap bbox prefilter
// (0.001° ≈ 111 m lat / 82 m lon here, so nothing within 50 m is cut off).
const dist = (a: string, b: string) =>
  `(6371000 * 2 * asin(sqrt(power(sin(radians(${b}.lat - ${a}.lat) / 2), 2) +
     cos(radians(${a}.lat)) * cos(radians(${b}.lat)) * power(sin(radians(${b}.lon - ${a}.lon) / 2), 2))))`;
const near = (a: string, b: string, m: number) =>
  `abs(${a}.lat - ${b}.lat) < 0.001 AND abs(${a}.lon - ${b}.lon) < 0.001 AND ${dist(a, b)} <= ${m}`;

type Sql = NeonQueryFunction<false, false>;
type Row = Record<string, any>;

async function ingest(sql: Sql, dets: Detection[]) {
  const ids = dets.map((d) => d.detection_id);

  // 1. Upsert. pothole_id is left alone on conflict so a retry never moves a detection.
  await sql.query(
    `INSERT INTO detections (detection_id, source, lat, lon, captured_at, confidence, bbox,
                             image_url, verdict, verdict_reason)
     SELECT detection_id, source, lat, lon, captured_at, confidence, bbox, image_url, verdict, verdict_reason
       FROM jsonb_to_recordset($1::jsonb) AS x(detection_id text, source text, lat float8, lon float8,
            captured_at timestamptz, confidence real, bbox jsonb, image_url text, verdict text,
            verdict_reason text)
     ON CONFLICT (detection_id) DO UPDATE SET
       source = EXCLUDED.source, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
       captured_at = EXCLUDED.captured_at, confidence = EXCLUDED.confidence, bbox = EXCLUDED.bbox,
       image_url = EXCLUDED.image_url, verdict = EXCLUDED.verdict,
       verdict_reason = EXCLUDED.verdict_reason`,
    [JSON.stringify(dets)],
  );

  return place(sql, ids);
}

/** Steps 2–4: match unassigned detections to potholes, create new ones, recompute state. */
async function place(sql: Sql, ids: string[]) {
  // 2. Attach every unassigned one to its nearest existing pothole ≤ 50 m.
  await sql.query(
    `UPDATE detections d SET pothole_id = m.pothole_id
       FROM (SELECT d.detection_id,
                    (SELECT p.pothole_id FROM potholes p WHERE ${near('p', 'd', MATCH_M)}
                      ORDER BY ${dist('p', 'd')} LIMIT 1) AS pothole_id
               FROM detections d
              WHERE d.detection_id = ANY($1) AND d.pothole_id IS NULL) m
      WHERE d.detection_id = m.detection_id AND m.pothole_id IS NOT NULL`,
    [ids],
  );

  // 3. The rest: create a pothole when the contract allows it (oldest first).
  const loose = (await sql.query(
    `SELECT d.detection_id, d.lat, d.lon, d.verdict, d.image_url,
            EXISTS (SELECT 1 FROM detections o
                     WHERE o.detection_id <> d.detection_id
                       AND o.verdict IN ('pothole', 'unverified')
                       AND ${near('o', 'd', MATCH_M)}) AS has_neighbour
       FROM detections d
      WHERE d.detection_id = ANY($1) AND d.pothole_id IS NULL
      ORDER BY d.captured_at`,
    [ids],
  )) as Row[];

  for (const d of loose) {
    // Contract v3: only verified detections create new potholes. Two unverified sightings may
    // create one only when they can never be checked (vision check off, or no fetchable image);
    // otherwise they wait, stored with pothole_id = null, until the check gives a verdict.
    const waitsForCheck = verifyOn() && checkableUrl(d.image_url);
    const creates = d.verdict === 'pothole' || (d.verdict === 'unverified' && d.has_neighbour && !waitsForCheck);
    if (!creates) continue;
    const newId = `ph_${d.detection_id.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
    // Insert only if nothing appeared within 50 m meanwhile (earlier loop turn or a
    // concurrent request), then pull every unassigned pothole/unverified detection
    // within 50 m of whichever pothole is now closest.
    await sql.query(
      `INSERT INTO potholes (pothole_id, lat, lon, address)
       SELECT $1, d.lat, d.lon,
              coalesce((SELECT c.address FROM city_reports c WHERE ${near('c', 'd', ADDRESS_M)}
                         ORDER BY ${dist('c', 'd')} LIMIT 1), '')
         FROM detections d
        WHERE d.detection_id = $2
          AND NOT EXISTS (SELECT 1 FROM potholes p WHERE ${near('p', 'd', MATCH_M)})
       ON CONFLICT (pothole_id) DO NOTHING`,
      [newId, d.detection_id],
    );
    await sql.query(
      `WITH target AS (
         SELECT p.pothole_id, p.lat, p.lon FROM potholes p, detections d
          WHERE d.detection_id = $1 AND ${near('p', 'd', MATCH_M)}
          ORDER BY ${dist('p', 'd')} LIMIT 1)
       UPDATE detections o SET pothole_id = t.pothole_id
         FROM target t
        WHERE o.pothole_id IS NULL
          AND (o.detection_id = $1 OR (o.verdict IN ('pothole', 'unverified') AND ${near('o', 't', MATCH_M)}))`,
      [d.detection_id],
    );
  }

  // 4. Recompute state + last_seen_at for every pothole these detections touch.
  const results = (await sql.query(
    `SELECT detection_id, pothole_id FROM detections WHERE detection_id = ANY($1)`,
    [ids],
  )) as Row[];
  const potholeIds = [...new Set(results.map((r) => r.pothole_id).filter(Boolean))] as string[];
  if (potholeIds.length) {
    await sql.query(`SELECT recompute_pothole(id) FROM unnest($1::text[]) AS id`, [potholeIds]);
  }

  const order = new Map(ids.map((id, i) => [id, i]));
  results.sort((a, b) => order.get(a.detection_id)! - order.get(b.detection_id)!);
  return { ok: true, pothole_ids: potholeIds, results };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }
  if (new URL(request.url).searchParams.get('verify') === 'only') return verifyOnly(body);
  const dets = parseDetectionsBody(body);
  if (typeof dets === 'string') return json({ ok: false, error: dets }, 400);

  if (!process.env.DATABASE_URL) return json({ ok: false, error: 'DATABASE_URL not set' }, 503);
  const sql = neon(process.env.DATABASE_URL);
  let result;
  try {
    result = await ingest(sql, dets);
  } catch (err) {
    console.error('detections: failed', err);
    return json({ ok: false, error: 'database error, safe to retry' }, 503);
  }

  const toCheck = verifiable(dets);
  // Also re-check a few older sightings that are still unverified (e.g. the model was down).
  if (verifyOn()) {
    try {
      const fresh = new Set(toCheck.map((d) => d.detection_id));
      const stale = (await sql.query(
        `SELECT detection_id, image_url, bbox, to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at
           FROM detections
          WHERE verdict = 'unverified' AND verify_attempts < ${MAX_ATTEMPTS}
            AND created_at < now() - interval '1 minute' AND created_at > now() - interval '2 days'
            AND image_url LIKE 'https://%' AND image_url NOT LIKE '%.invalid/%'
          ORDER BY created_at DESC LIMIT ${RETRY_STALE}`,
      )) as Row[];
      for (const r of stale) if (!fresh.has(r.detection_id)) toCheck.push(r as unknown as Detection);
    } catch (err) {
      console.error('verify: stale lookup failed', err); // never blocks the producer
    }
  }
  if (toCheck.length) {
    // ?verify=wait finishes the check before answering (tests, or a producer that wants it).
    const job = verifyAndPlace(sql, toCheck);
    if (new URL(request.url).searchParams.get('verify') === 'wait') {
      return json({ ...result, verified: await job });
    }
    waitUntil(job);
  }
  return json({ ...result, verifying: toCheck.length });
}

/** Unverified detections with a real image, newest first, capped at VERIFY_MAX. */
export function verifiable(dets: Detection[]): Detection[] {
  if (!verifyOn()) return [];
  return dets
    .filter((d) => d.verdict === 'unverified' && checkableUrl(d.image_url))
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at))
    .slice(0, VERIFY_MAX);
}

/** Vision-check each detection, store the verdict (only if still unverified), re-match. */
export async function verifyAndPlace(sql: Sql, dets: Detection[]) {
  const opts = {
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: process.env.OPENROUTER_MODEL!,
    baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
  };
  const done: { detection_id: string; verdict: string | null }[] = [];
  const queue = [...dets];
  async function worker() {
    for (let d = queue.shift(); d; d = queue.shift()) {
      try {
        await sql.query(`UPDATE detections SET verify_attempts = verify_attempts + 1 WHERE detection_id = $1`, [d.detection_id]);
      } catch { /* counting attempts is best-effort */ }
      const checked = await verifyImage(d.image_url, d.bbox, opts);
      if (!checked) {
        done.push({ detection_id: d.detection_id, verdict: null });
        continue;
      }
      try {
        await sql.query(
          `UPDATE detections SET verdict = $2, verdict_reason = $3
            WHERE detection_id = $1 AND verdict = 'unverified'`,
          [d.detection_id, checked.verdict, checked.reason],
        );
        // Re-match: a confirmed pothole may now create one; state may flip either way.
        const { results } = await place(sql, [d.detection_id]);
        const pid = results[0]?.pothole_id;
        if (pid) await sql.query(`SELECT recompute_pothole($1)`, [pid]);
        done.push({ detection_id: d.detection_id, verdict: checked.verdict });
      } catch (err) {
        console.error('verify: store failed', d.detection_id, err);
        done.push({ detection_id: d.detection_id, verdict: null });
      }
    }
  }
  await Promise.all(Array.from({ length: VERIFY_PARALLEL }, worker));
  return done;
}

const VERIFY_ONLY_MAX = 30;

/** ?verify=only — run the vision check on our own R2 images and return the verdicts.
 *  Writes nothing (no detection, no pin). For measuring the check on labelled test frames.
 *  body: { checks: [{ image_url, bbox: [x, y, w, h] | null }] }, at most VERIFY_ONLY_MAX. */
async function verifyOnly(body: unknown): Promise<Response> {
  if (!verifyOn()) return json({ ok: false, error: 'vision check is off on this deployment' }, 503);
  const checks = (body as any)?.checks;
  if (!Array.isArray(checks) || !checks.length || checks.length > VERIFY_ONLY_MAX)
    return json({ ok: false, error: `checks must be an array of 1-${VERIFY_ONLY_MAX}` }, 400);
  const prefix = `${(process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '')}/`;
  for (const c of checks) {
    const okBox = c?.bbox === null || (Array.isArray(c?.bbox) && c.bbox.length === 4 &&
      c.bbox.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)));
    if (typeof c?.image_url !== 'string' || !process.env.R2_PUBLIC_URL || !c.image_url.startsWith(prefix) || !okBox)
      return json({ ok: false, error: 'each check needs an image_url on our R2 bucket and bbox [x,y,w,h] or null' }, 400);
  }
  const opts = {
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: process.env.OPENROUTER_MODEL!,
    baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
  };
  const results: (Awaited<ReturnType<typeof verifyImage>>)[] = new Array(checks.length).fill(null);
  let next = 0;
  async function worker() {
    for (let i = next++; i < checks.length; i = next++) {
      results[i] = await verifyImage(checks[i].image_url, checks[i].bbox, opts);
    }
  }
  await Promise.all(Array.from({ length: VERIFY_PARALLEL }, worker));
  return json({ ok: true, model: opts.model, results });
}

export function OPTIONS(): Response {
  return preflight();
}
