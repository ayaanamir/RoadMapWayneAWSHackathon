// GET /api/potholes          → { "potholes": Pothole[] }
// GET /api/potholes?id=<id>  → Pothole (404 if unknown)
// Each pothole carries `owner`: who fixes that road and where to report it (_lib/owner.ts).
// Reads Neon. If DATABASE_URL is missing or the query fails, serves
// shared/fixtures/potholes.sample.json so the map never goes blank
// (response header X-Data-Source says which one you got).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { json, preflight } from './_lib/http';
import { roadOwner } from './_lib/owner';

type Row = Record<string, any>;

const iso = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

function loadFixture(): Row[] {
  const file = join(process.cwd(), 'shared', 'fixtures', 'potholes.sample.json');
  return JSON.parse(readFileSync(file, 'utf8')).potholes;
}

async function loadFromNeon(url: string, id: string | null): Promise<Row[]> {
  const sql = neon(url);
  const where = id ? 'WHERE pothole_id = $1' : '';
  const params = id ? [id] : [];

  const [potholes, reports, detections] = await Promise.all([
    sql.query(
      `SELECT pothole_id, lat, lon, address, state, ${iso('last_seen_at')} AS last_seen_at
         FROM potholes ${where} ORDER BY pothole_id`,
      params,
    ),
    sql.query(
      `SELECT issue_id, address, lat, lon, status, ${iso('created_at')} AS created_at,
              ${iso('closed_at')} AS closed_at, issue_url, photo_url, pothole_id
         FROM city_reports ${id ? where : 'WHERE pothole_id IS NOT NULL'} ORDER BY created_at`,
      params,
    ),
    sql.query(
      `SELECT detection_id, source, lat, lon, ${iso('captured_at')} AS captured_at, confidence,
              bbox, image_url, verdict, verdict_reason, pothole_id
         FROM detections ${id ? where : 'WHERE pothole_id IS NOT NULL'} ORDER BY captured_at`,
      params,
    ),
  ]);

  const byId = new Map<string, Row>();
  for (const p of potholes as Row[]) byId.set(p.pothole_id, { ...p, city_reports: [], detections: [] });
  for (const { pothole_id, ...r } of reports as Row[]) byId.get(pothole_id)?.city_reports.push(r);
  for (const { pothole_id, ...d } of detections as Row[]) byId.get(pothole_id)?.detections.push(d);
  return [...byId.values()];
}

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id');
  let potholes: Row[];
  let source = 'neon';

  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
    potholes = await loadFromNeon(process.env.DATABASE_URL, id);
  } catch (err) {
    console.error('potholes: falling back to fixtures:', err);
    source = 'fixture';
    potholes = loadFixture();
    if (id) potholes = potholes.filter((p) => p.pothole_id === id);
  }

  potholes = potholes.map((p) => ({ ...p, owner: roadOwner(p.address) }));

  const headers = { 'X-Data-Source': source };
  if (id) {
    return potholes[0]
      ? json(potholes[0], 200, headers)
      : json({ error: `no pothole ${id}` }, 404, headers);
  }
  return json({ potholes }, 200, headers);
}

export function OPTIONS(): Response {
  return preflight();
}
