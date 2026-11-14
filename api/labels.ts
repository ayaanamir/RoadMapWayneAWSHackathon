// /api/labels — INTERNAL tooling (not in shared/CONTRACTS.md): team review of dash-cam frames
// for model training. A vision model ("teacher") pre-draws pothole boxes on the server (the
// OpenRouter key never leaves Vercel); teammates confirm/fix them at /label. Spec:
// pipeline/autolabel/README.md ("Team review"). Table: label_frames (services/api/schema.sql).
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { json, preflight } from './_lib/http';
import { teach, TEACHER_MODEL_DEFAULT, type NBox } from './_lib/teacher';

type Sql = NeonQueryFunction<false, false>;
type Row = Record<string, any>;

const LOCK_MIN = 3;            // a reviewer holds a frame this long
const TEACH_LOCK_SEC = 90;     // one teacher call per frame at a time
const ID_RE = /^crowd_[A-Za-z0-9_-]{1,120}$/;
const FRAME_COLS = `frame_id, image_url, split, video_id, t_sec, status, teacher, teacher_error,
                    boxes, reviewed_by, reviewed_at`;

const db = (): Sql | null => (process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null);
const bad = (error: string, status = 400) => json({ ok: false, error }, status);
const who = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null);

/** Human boxes: [] or up to 50 normalised boxes, clamped to the image. */
function cleanBoxes(v: unknown): NBox[] | null {
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: NBox[] = [];
  for (const b of v) {
    const n = [b?.x, b?.y, b?.w, b?.h].map(Number);
    if (n.some((x) => !Number.isFinite(x))) return null;
    let [x, y, w, h] = n;
    x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
    w = Math.min(1 - x, Math.max(0, w)); h = Math.min(1 - y, Math.max(0, h));
    if (w <= 0 || h <= 0) continue;
    const r = (q: number) => Math.round(q * 10000) / 10000;
    out.push({ x: r(x), y: r(y), w: r(w), h: r(h) });
  }
  return out;
}

export async function GET(request: Request): Promise<Response> {
  const sql = db();
  if (!sql) return bad('DATABASE_URL not set', 503);
  const q = new URL(request.url).searchParams;
  try {
    if (q.has('stats')) {
      const [s] = (await sql.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'new')::int AS new,
                count(*) FILTER (WHERE status = 'taught')::int AS taught,
                count(*) FILTER (WHERE status = 'reviewed')::int AS reviewed,
                count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
                count(*) FILTER (WHERE status = 'reviewed' AND jsonb_array_length(boxes) > 0)::int AS potholes,
                count(*) FILTER (WHERE status = 'reviewed' AND jsonb_array_length(boxes) = 0)::int AS empty,
                count(*) FILTER (WHERE status = 'taught' AND split = 'test')::int AS test_left,
                count(*) FILTER (WHERE status = 'taught' AND split = 'train')::int AS train_left,
                count(*) FILTER (WHERE teacher_error IS NOT NULL AND status = 'new')::int AS teach_errors
           FROM label_frames`,
      )) as Row[];
      const people = (await sql.query(
        `SELECT reviewed_by, count(*)::int AS n FROM label_frames
          WHERE status IN ('reviewed', 'skipped') AND reviewed_by IS NOT NULL
          GROUP BY reviewed_by ORDER BY n DESC`,
      )) as Row[];
      return json({ ...s, by_reviewer: Object.fromEntries(people.map((p) => [p.reviewed_by, p.n])) });
    }

    if (q.has('next')) {
      const name = who(q.get('who'));
      if (!name) return bad('who=<your name> is required');
      // Atomic claim: the inner SELECT … FOR UPDATE SKIP LOCKED means two reviewers asking at the
      // same moment can never get the same frame. Test frames first, then frames where the
      // teacher saw something (most informative), then the rest.
      const rows = (await sql.query(
        `UPDATE label_frames SET lock_by = $1, lock_until = now() + interval '${LOCK_MIN} minutes'
          WHERE frame_id = (
            SELECT frame_id FROM label_frames
             WHERE status = 'taught' AND (lock_until IS NULL OR lock_until < now() OR lock_by = $1)
             ORDER BY (lock_by = $1 AND lock_until > now()) DESC NULLS LAST,
                      (split = 'test') DESC,
                      (jsonb_array_length(coalesce(teacher->'potholes', '[]'))
                       + jsonb_array_length(coalesce(teacher->'lookalikes', '[]')) > 0) DESC,
                      frame_id
             LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING ${FRAME_COLS}`,
        [name],
      )) as Row[];
      return json({ frame: rows[0] ?? null });
    }

    if (q.has('id')) {
      const rows = (await sql.query(`SELECT ${FRAME_COLS} FROM label_frames WHERE frame_id = $1`, [q.get('id')])) as Row[];
      return rows[0] ? json(rows[0]) : bad('unknown frame', 404);
    }

    if (q.has('export')) {
      const split = q.get('split');
      const rows = (await sql.query(
        `SELECT ${FRAME_COLS} FROM label_frames WHERE status = 'reviewed'
           ${split === 'train' || split === 'test' ? 'AND split = $1' : ''} ORDER BY frame_id`,
        split === 'train' || split === 'test' ? [split] : [],
      )) as Row[];
      return json({ frames: rows });
    }

    if (q.get('todo') === 'teach') {
      const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 200));
      const rows = (await sql.query(
        `SELECT frame_id FROM label_frames
          WHERE status = 'new' AND (lock_until IS NULL OR lock_until < now())
          ORDER BY (split = 'test') DESC, frame_id LIMIT $1`,
        [limit],
      )) as Row[];
      return json({ frame_ids: rows.map((r) => r.frame_id) });
    }

    return bad('use ?stats=1, ?next=1&who=, ?id=, ?export=1 or ?todo=teach');
  } catch (err) {
    console.error('labels GET failed', err);
    return bad('database error, safe to retry', 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  const sql = db();
  if (!sql) return bad('DATABASE_URL not set', 503);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return bad('body must be JSON');
  }
  try {
    switch (body?.action) {
      case 'add': return await add(sql, body);
      case 'teach': return await teachOne(sql, body);
      case 'review': return await review(sql, body);
      case 'skip':
      case 'release': return await releaseOrSkip(sql, body);
      default: return bad('action must be add | teach | review | skip | release');
    }
  } catch (err) {
    console.error('labels POST failed', body?.action, err);
    return bad('database error, safe to retry', 503);
  }
}

async function add(sql: Sql, body: any): Promise<Response> {
  const frames = body.frames;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > 500) return bad('frames: 1-500 items');
  const prefix = `${(process.env.R2_PUBLIC_URL ?? '').replace(/\/+$/, '')}/frames/crowd_`;
  const rows = [];
  for (const [i, f] of frames.entries()) {
    if (!ID_RE.test(f?.frame_id ?? '')) return bad(`frames[${i}].frame_id must look like crowd_<video>_<t>`);
    if (typeof f.image_url !== 'string' || !process.env.R2_PUBLIC_URL || !f.image_url.startsWith(prefix))
      return bad(`frames[${i}].image_url must be one of our R2 frames (${prefix}…)`);
    rows.push({
      frame_id: f.frame_id, image_url: f.image_url,
      split: f.split === 'test' ? 'test' : 'train',
      video_id: String(f.video_id ?? '').slice(0, 40),
      t_sec: Number.isFinite(Number(f.t_sec)) ? Number(f.t_sec) : null,
    });
  }
  const res = (await sql.query(
    `INSERT INTO label_frames (frame_id, image_url, split, video_id, t_sec)
     SELECT frame_id, image_url, split, video_id, t_sec
       FROM jsonb_to_recordset($1::jsonb) AS x(frame_id text, image_url text, split text, video_id text, t_sec real)
     ON CONFLICT (frame_id) DO UPDATE SET image_url = EXCLUDED.image_url, split = EXCLUDED.split,
       video_id = EXCLUDED.video_id, t_sec = EXCLUDED.t_sec
     RETURNING frame_id`,
    [JSON.stringify(rows)],
  )) as Row[];
  return json({ ok: true, added: res.length });
}

async function teachOne(sql: Sql, body: any): Promise<Response> {
  const id = body.frame_id;
  if (!ID_RE.test(id ?? '')) return bad('frame_id required');
  const { OPENROUTER_API_KEY } = process.env;
  if (!OPENROUTER_API_KEY) return bad('OPENROUTER_API_KEY not set', 503);
  // Claim the frame for the teacher. Only status 'new' frames are ever sent to the model, and the
  // lock stops two concurrent calls labelling the same frame twice — so cost is bounded by frames.
  const claimed = (await sql.query(
    `UPDATE label_frames SET lock_by = '_teacher', lock_until = now() + interval '${TEACH_LOCK_SEC} seconds'
      WHERE frame_id = $1 AND status = 'new' AND (lock_until IS NULL OR lock_until < now())
      RETURNING image_url`,
    [id],
  )) as Row[];
  if (!claimed[0]) {
    const cur = (await sql.query(`SELECT ${FRAME_COLS} FROM label_frames WHERE frame_id = $1`, [id])) as Row[];
    return cur[0] ? json({ ok: true, frame: cur[0], note: 'already taught or in progress' }) : bad('unknown frame', 404);
  }
  const model = process.env.TEACHER_MODEL || TEACHER_MODEL_DEFAULT;
  try {
    const t = await teach(claimed[0].image_url, {
      apiKey: OPENROUTER_API_KEY, model, baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
    });
    const rows = (await sql.query(
      `UPDATE label_frames SET teacher = $2::jsonb, teacher_model = $3, teacher_error = NULL,
              status = 'taught', lock_by = NULL, lock_until = NULL
        WHERE frame_id = $1 RETURNING ${FRAME_COLS}`,
      [id, JSON.stringify(t), model],
    )) as Row[];
    return json({ ok: true, frame: rows[0] });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 300);
    await sql.query(
      `UPDATE label_frames SET teacher_error = $2, lock_by = NULL, lock_until = NULL WHERE frame_id = $1`,
      [id, msg],
    );
    return bad(`teacher failed: ${msg}`, 503);
  }
}

async function review(sql: Sql, body: any): Promise<Response> {
  const name = who(body.who);
  if (!name) return bad('who is required');
  if (!ID_RE.test(body.frame_id ?? '')) return bad('frame_id required');
  const boxes = cleanBoxes(body.boxes);
  if (!boxes) return bad('boxes must be an array (≤50) of {x,y,w,h} in 0-1');
  const ms = Number.isFinite(Number(body.ms)) ? Math.min(3_600_000, Math.max(0, Math.round(Number(body.ms)))) : null;
  const rows = (await sql.query(
    `UPDATE label_frames SET boxes = $2::jsonb, status = 'reviewed', reviewed_by = $3, reviewed_at = now(),
            review_ms = $4, lock_by = NULL, lock_until = NULL
      WHERE frame_id = $1 AND status IN ('taught', 'reviewed', 'skipped') RETURNING frame_id`,
    [body.frame_id, JSON.stringify(boxes), name, ms],
  )) as Row[];
  return rows[0] ? json({ ok: true }) : bad('unknown frame (or not taught yet)', 404);
}

async function releaseOrSkip(sql: Sql, body: any): Promise<Response> {
  const name = who(body.who);
  if (!name) return bad('who is required');
  if (!ID_RE.test(body.frame_id ?? '')) return bad('frame_id required');
  const rows = body.action === 'skip'
    ? ((await sql.query(
        `UPDATE label_frames SET status = 'skipped', reviewed_by = $2, reviewed_at = now(),
                lock_by = NULL, lock_until = NULL
          WHERE frame_id = $1 AND status IN ('taught', 'reviewed', 'skipped') RETURNING frame_id`,
        [body.frame_id, name],
      )) as Row[])
    : ((await sql.query(
        `UPDATE label_frames SET lock_by = NULL, lock_until = NULL
          WHERE frame_id = $1 AND lock_by = $2 RETURNING frame_id`,
        [body.frame_id, name],
      )) as Row[]);
  return json({ ok: true, changed: rows.length });
}

export function OPTIONS(): Response {
  return preflight();
}
