// /api/city-check — INTERNAL (not in shared/CONTRACTS.md), #133. Checks that city "Potholes"
// reports really are road damage, on the server so the OpenRouter key never leaves Vercel.
//
// GET  /api/city-check            → { checked, not_pothole, unchecked, rejected: [{issue_id, address, reason}] }
// POST /api/city-check?limit=25   → checks up to `limit` unchecked reports (oldest first) and returns
//                                    { ok, checked, not_pothole, failed, remaining, busy }
//                                    busy = SeeClickFix rate-limited us; wait ~a minute and call again
//
// A `not_pothole` report keeps its row but leaves its pothole (pothole_id = NULL), like a rejected
// detection; recompute_pothole() then drops pins with nothing left. Each report is sent to the model
// at most MAX_ATTEMPTS times ever, so repeated calls can't run up cost (a SeeClickFix failure costs
// nothing and doesn't use up an attempt). services/api/ingest_city.py
// calls POST after every ingest until `remaining` is 0.
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { json, preflight } from './_lib/http';
import { checkReport } from './_lib/citycheck';

type Sql = NeonQueryFunction<false, false>;
type Row = Record<string, any>;

const MAX_ATTEMPTS = 3;
const MAX_LIMIT = 15;
const PARALLEL = 1; // one at a time, with a pause: be gentle on SeeClickFix
const PAUSE_MS = 700;
const MODEL_DEFAULT = 'google/gemini-3.5-flash-lite';

const db = (): Sql | null => (process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null);
const UNCHECKED = `check_verdict IS NULL AND check_attempts < ${MAX_ATTEMPTS}`;

export async function GET(): Promise<Response> {
  const sql = db();
  if (!sql) return json({ ok: false, error: 'DATABASE_URL not set' }, 503);
  const [s] = (await sql.query(
    `SELECT count(*) FILTER (WHERE check_verdict IS NOT NULL)::int AS checked,
            count(*) FILTER (WHERE check_verdict = 'not_pothole')::int AS not_pothole,
            count(*) FILTER (WHERE ${UNCHECKED})::int AS unchecked
       FROM city_reports`,
  )) as Row[];
  const rejected = await sql.query(
    `SELECT issue_id, address, check_reason AS reason, issue_url FROM city_reports
      WHERE check_verdict = 'not_pothole' ORDER BY created_at DESC`,
  );
  return json({ ok: true, ...s, rejected });
}

export async function POST(request: Request): Promise<Response> {
  const sql = db();
  if (!sql) return json({ ok: false, error: 'DATABASE_URL not set' }, 503);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'OPENROUTER_API_KEY not set' }, 503);
  const n = Number(new URL(request.url).searchParams.get('limit') ?? 10);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(n) ? Math.floor(n) : 10));
  const opts = {
    apiKey,
    model: process.env.CITY_CHECK_MODEL || process.env.OPENROUTER_MODEL || MODEL_DEFAULT,
    baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
    scfBase: process.env.SCF_BASE_URL || undefined,
  };

  // Claim a batch (SKIP LOCKED: two calls at once never take the same report).
  const batch = (await sql.query(
    `UPDATE city_reports SET check_attempts = check_attempts + 1
      WHERE issue_id IN (SELECT issue_id FROM city_reports WHERE ${UNCHECKED}
                          ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING issue_id, address, pothole_id`,
    [limit],
  )) as Row[];

  let checked = 0;
  let rejected = 0;
  let busy = false;
  const refund: string[] = []; // never reached the model: give the attempt back
  const touched = new Set<string>();
  const queue = [...batch];
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        if (busy) { refund.push(r.issue_id); continue; }
        const got = await checkReport(r.issue_id, r.address, opts);
        if (got.kind === 'busy') { busy = true; refund.push(r.issue_id); continue; }
        if (got.kind === 'no_report') { refund.push(r.issue_id); continue; }
        await new Promise((ok) => setTimeout(ok, PAUSE_MS));
        if (got.kind !== 'ok') continue;
        await sql.query(
          `UPDATE city_reports
              SET check_verdict = $2, check_reason = $3, check_model = $4,
                  photo_url = coalesce(photo_url, $5),
                  pothole_id = CASE WHEN $2 = 'not_pothole' THEN NULL ELSE pothole_id END
            WHERE issue_id = $1`,
          [r.issue_id, got.verdict, got.reason, opts.model, got.photo_url],
        );
        checked++;
        if (got.verdict === 'not_pothole') {
          rejected++;
          if (r.pothole_id) touched.add(r.pothole_id);
        }
      }
    }),
  );

  if (refund.length) {
    await sql.query(
      `UPDATE city_reports SET check_attempts = greatest(0, check_attempts - 1) WHERE issue_id = ANY($1)`,
      [refund],
    );
  }

  if (touched.size) {
    const ids = [...touched];
    // Pins our camera hasn't seen sit at the mean of their city reports: re-centre on what's left.
    await sql.query(
      `UPDATE potholes p SET lat = c.lat, lon = c.lon, address = c.address, updated_at = now()
         FROM (SELECT pothole_id, avg(lat) AS lat, avg(lon) AS lon,
                      (array_agg(address ORDER BY created_at DESC))[1] AS address
                 FROM city_reports WHERE pothole_id = ANY($1) GROUP BY pothole_id) c
        WHERE p.pothole_id = c.pothole_id
          AND NOT EXISTS (SELECT 1 FROM detections d WHERE d.pothole_id = p.pothole_id)`,
      [ids],
    );
    await sql.query(`SELECT recompute_pothole(id) FROM unnest($1::text[]) AS id`, [ids]);
  }

  const [{ remaining }] = (await sql.query(
    `SELECT count(*)::int AS remaining FROM city_reports WHERE ${UNCHECKED}`,
  )) as Row[];
  return json({ ok: true, checked, not_pothole: rejected, failed: batch.length - checked, remaining, busy });
}

export function OPTIONS(): Response {
  return preflight();
}
