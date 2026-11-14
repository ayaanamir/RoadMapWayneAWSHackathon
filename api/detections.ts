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
import { neon } from '@neondatabase/serverless';
import { json, preflight } from './_lib/http';
import { parseDetectionsBody, type Detection } from './_lib/detection';

const MATCH_M = 50;
const ADDRESS_M = 100; // borrow the nearest city report's address for new potholes

// Haversine in metres between row aliases a and b, with a cheap bbox prefilter
// (0.001° ≈ 111 m lat / 82 m lon here, so nothing within 50 m is cut off).
const dist = (a: string, b: string) =>
  `(6371000 * 2 * asin(sqrt(power(sin(radians(${b}.lat - ${a}.lat) / 2), 2) +
     cos(radians(${a}.lat)) * cos(radians(${b}.lat)) * power(sin(radians(${b}.lon - ${a}.lon) / 2), 2))))`;
const near = (a: string, b: string, m: number) =>
  `abs(${a}.lat - ${b}.lat) < 0.001 AND abs(${a}.lon - ${b}.lon) < 0.001 AND ${dist(a, b)} <= ${m}`;

type Sql = ReturnType<typeof neon>;
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
    `SELECT d.detection_id, d.lat, d.lon, d.verdict,
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
    const creates = d.verdict === 'pothole' || (d.verdict === 'unverified' && d.has_neighbour);
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
  const dets = parseDetectionsBody(body);
  if (typeof dets === 'string') return json({ ok: false, error: dets }, 400);

  if (!process.env.DATABASE_URL) return json({ ok: false, error: 'DATABASE_URL not set' }, 503);
  try {
    return json(await ingest(neon(process.env.DATABASE_URL), dets));
  } catch (err) {
    console.error('detections: failed', err);
    return json({ ok: false, error: 'database error, safe to retry' }, 503);
  }
}

export function OPTIONS(): Response {
  return preflight();
}
