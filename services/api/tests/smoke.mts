// Local end-to-end check of every API handler — no Vercel deploy needed.
// Calls the exported GET/POST functions directly against a Neon database.
//
//   SMOKE_DATABASE_URL=<a Neon *branch*, not production> npx -y tsx services/api/tests/smoke.mts
//
// It writes test detections (ids "smoke-…"), so point it at a throwaway Neon branch.
// R2 upload is exercised only if the R2_* vars are set too; otherwise just its validation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.SMOKE_DATABASE_URL;
if (!url) {
  console.error('Set SMOKE_DATABASE_URL to a Neon branch connection string (not production).');
  process.exit(2);
}
process.env.DATABASE_URL = url;

// Fake OpenRouter: answers by image name (…/hole.jpg → pothole, …/flat.jpg → shadow, …/down.jpg → 500).
import http from 'node:http';
const fakeCalls: string[] = [];
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const msg = JSON.parse(b).messages[0].content;
    const img: string = msg.find((c: any) => c.type === 'image_url').image_url.url;
    fakeCalls.push(img);
    if (img.endsWith('down.jpg')) { res.writeHead(500); return res.end('boom'); }
    const verdict = img.endsWith('hole.jpg') ? 'pothole' : 'shadow';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: `{"verdict":"${verdict}","reason":"fake ${verdict}"}` } }] }));
  });
}).listen(0);
await new Promise((r) => fake.once('listening', r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
process.env.OPENROUTER_API_KEY = 'test';
process.env.OPENROUTER_MODEL = 'fake/vision';

const health = await import('../../../api/health');
const potholes = await import('../../../api/potholes');
const detections = await import('../../../api/detections');
const upload = await import('../../../api/upload');

const BASE = 'http://local';
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
const body = async (r: Response) => ({ status: r.status, json: (await r.json()) as any });
const getPothole = async (id: string) => body(await potholes.GET(new Request(`${BASE}/api/potholes?id=${id}`)));
const post = async (payload: unknown) =>
  body(
    await detections.POST(
      new Request(`${BASE}/api/detections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }),
    ),
  );
const det = (over: Record<string, unknown>) => ({
  detection_id: `smoke-${randomUUID()}`,
  source: 'live',
  lat: 42.3443781,
  lon: -83.0580132,
  captured_at: new Date().toISOString(),
  confidence: 0.7,
  bbox: [10, 20, 30, 40],
  image_url: 'https://example.invalid/frames/smoke.jpg',
  verdict: 'unverified',
  verdict_reason: null,
  ...over,
});
// Far from any city report (Belle Isle), nudged per run so reruns don't collide.
const far = () => ({ lat: 42.3405 + Math.random() * 0.004, lon: -82.985 + Math.random() * 0.004 });
const metres = (m: number) => m / 111_320; // north offset in degrees latitude

console.log('health / potholes');
await check('GET /api/health → {ok:true}', async () => {
  const r = await body(health.GET());
  assert.deepEqual(r, { status: 200, json: { ok: true } });
});
await check('GET /api/potholes → list from Neon, contract shape', async () => {
  const res = await potholes.GET(new Request(`${BASE}/api/potholes`));
  assert.equal(res.headers.get('X-Data-Source'), 'neon');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const { potholes: list } = (await res.json()) as any;
  assert.ok(list.length > 3, `expected the ingested potholes, got ${list.length}`);
  for (const k of ['pothole_id', 'lat', 'lon', 'address', 'state', 'last_seen_at', 'city_reports', 'detections'])
    assert.ok(k in list[0], `missing ${k}`);
});
await check('GET ?id=ph_peterboro_73 → 3 city reports, ISO UTC dates', async () => {
  const r = await getPothole('ph_peterboro_73');
  assert.equal(r.status, 200);
  assert.equal(r.json.city_reports.length, 3);
  assert.match(r.json.city_reports[0].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});
await check('GET ?id=unknown → 404', async () => {
  assert.equal((await getPothole('nope')).status, 404);
});

console.log('POST /api/detections — validation');
await check('bad JSON → 400', async () => assert.equal((await post('{nope')).status, 400));
await check('bad verdict → 400 naming the field', async () => {
  const r = await post(det({ verdict: 'maybe' }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /verdict/);
});
await check('batch with a bad item → 400 naming the index', async () => {
  const r = await post({ detections: [det({}), det({ lat: 'x' })] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /detections\[1\]/);
});
await check('OPTIONS → 204 with CORS', async () => {
  const r = detections.OPTIONS();
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

console.log('POST /api/detections — matching + state (Peterboro: closed 2026-10-20)');
const before = (await getPothole('ph_peterboro_73')).json.detections.length;
const unv = det({});
await check('unverified at Peterboro → joins ph_peterboro_73, state unknown', async () => {
  const r = await post(unv);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.pothole_ids, ['ph_peterboro_73']);
  assert.equal(r.json.results[0].pothole_id, 'ph_peterboro_73');
  const p = await getPothole('ph_peterboro_73');
  assert.ok(['unknown', 'still_there', 'fixed_confirmed'].includes(p.json.state));
});
const verified = det({ source: 'drive', verdict: 'pothole', verdict_reason: 'deep edge', lat: 42.3443781 + metres(30) });
await check('verified pothole 30 m away → same pothole, state still_there, last_seen set', async () => {
  const r = await post(verified);
  assert.deepEqual(r.json.pothole_ids, ['ph_peterboro_73']);
  const p = await getPothole('ph_peterboro_73');
  assert.equal(p.json.state, 'still_there');
  assert.equal(p.json.last_seen_at, verified.captured_at.replace(/\.\d+Z$/, 'Z'));
  const got = p.json.detections.find((d: any) => d.detection_id === verified.detection_id);
  assert.equal(got.verdict_reason, 'deep edge');
  assert.deepEqual(got.bbox, [10, 20, 30, 40]);
});
await check('retry the same detection → no duplicate, same pothole', async () => {
  const r = await post(verified);
  assert.deepEqual(r.json.pothole_ids, ['ph_peterboro_73']);
  const p = await getPothole('ph_peterboro_73');
  assert.equal(p.json.detections.length, before + 2);
});
await check('later patch verdict → fixed_confirmed', async () => {
  const later = new Date(Date.now() + 60_000).toISOString();
  await post(det({ verdict: 'patch', captured_at: later }));
  assert.equal((await getPothole('ph_peterboro_73')).json.state, 'fixed_confirmed');
});
await check('even later pothole verdict → back to still_there', async () => {
  await post(det({ verdict: 'pothole', captured_at: new Date(Date.now() + 120_000).toISOString() }));
  assert.equal((await getPothole('ph_peterboro_73')).json.state, 'still_there');
});

console.log('POST /api/detections — new potholes (contract v3 matching rule)');
await check('lone shadow far away → stored, pothole_id null', async () => {
  const r = await post(det({ ...far(), verdict: 'shadow' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.pothole_ids, []);
  assert.equal(r.json.results[0].pothole_id, null);
});
await check('lone unverified far away → null; a 2nd within 50 m → new unreported pothole with both', async () => {
  const spot = far();
  const a = det({ ...spot });
  const r1 = await post(a);
  assert.equal(r1.json.results[0].pothole_id, null);
  const b = det({ lat: spot.lat + metres(20), lon: spot.lon });
  const r2 = await post(b);
  assert.equal(r2.json.pothole_ids.length, 1);
  const p = await getPothole(r2.json.pothole_ids[0]);
  assert.equal(p.json.state, 'unreported');
  assert.deepEqual(p.json.detections.map((d: any) => d.detection_id).sort(), [a.detection_id, b.detection_id].sort());
});
await check('lone verified pothole far away → new unreported pothole', async () => {
  const r = await post(det({ ...far(), verdict: 'pothole', source: 'drive' }));
  assert.equal(r.json.pothole_ids.length, 1);
  assert.equal((await getPothole(r.json.pothole_ids[0])).json.state, 'unreported');
});
await check('unverified that later gets verified (re-post) → creates the pothole', async () => {
  const d = det({ ...far() });
  assert.equal((await post(d)).json.results[0].pothole_id, null);
  const r = await post({ ...d, verdict: 'pothole' });
  assert.equal(r.json.pothole_ids.length, 1);
});
await check('batch of 3 at one new spot → one pothole, results in input order', async () => {
  const spot = far();
  const batch = [0, 10, 25].map((m) => det({ lat: spot.lat + metres(m), lon: spot.lon, source: 'drive' }));
  const t0 = Date.now();
  const r = await post({ detections: batch });
  assert.equal(r.status, 200);
  assert.equal(r.json.pothole_ids.length, 1);
  assert.deepEqual(r.json.results.map((x: any) => x.detection_id), batch.map((d) => d.detection_id));
  assert.ok(r.json.results.every((x: any) => x.pothole_id === r.json.pothole_ids[0]));
  console.log(`       (batch took ${Date.now() - t0} ms)`);
});

console.log('server-side vision check (fake OpenRouter)');
const postWait = async (payload: unknown) =>
  body(await detections.POST(new Request(`${BASE}/api/detections?verify=wait`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })));
await check('unverified + real image far away → model says pothole → new unreported pothole', async () => {
  const d = det({ ...far(), image_url: 'https://img.test/a/hole.jpg' });
  const r = await postWait(d);
  assert.equal(r.json.results[0].pothole_id, null, 'answer is sent before the check');
  assert.deepEqual(r.json.verified, [{ detection_id: d.detection_id, verdict: 'pothole' }]);
  const all = (await body(await potholes.GET(new Request(`${BASE}/api/potholes`)))).json.potholes;
  const p = all.find((x: any) => x.detections.some((y: any) => y.detection_id === d.detection_id));
  assert.ok(p, 'pothole created after verification');
  assert.equal(p.state, 'unreported');
  assert.equal(p.detections[0].verdict_reason, 'fake pothole');
});
await check('unverified live sighting at Peterboro → verified → still_there', async () => {
  await postWait(det({ verdict: 'patch', captured_at: new Date(Date.now() + 180_000).toISOString() }));
  assert.equal((await getPothole('ph_peterboro_73')).json.state, 'fixed_confirmed');
  await postWait(det({ image_url: 'https://img.test/b/hole.jpg', captured_at: new Date(Date.now() + 240_000).toISOString() }));
  assert.equal((await getPothole('ph_peterboro_73')).json.state, 'still_there');
});
await check('model says shadow → stored as shadow, no pothole', async () => {
  const d = det({ ...far(), image_url: 'https://img.test/c/flat.jpg' });
  const r = await postWait(d);
  assert.deepEqual(r.json.verified, [{ detection_id: d.detection_id, verdict: 'shadow' }]);
  assert.equal((await postWait({ ...d, verdict: 'shadow' })).json.results[0].pothole_id, null);
});
await check('model down → stays unverified, request still 200', async () => {
  const d = det({ ...far(), image_url: 'https://img.test/d/down.jpg' });
  const r = await postWait(d);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.verified, [{ detection_id: d.detection_id, verdict: null }]);
});
await check('producer verdicts and placeholder images are never sent to the model', async () => {
  const n = fakeCalls.length;
  const r = await postWait({ detections: [det({ ...far(), verdict: 'pothole', image_url: 'https://img.test/e/hole.jpg' }), det({ ...far() })] });
  assert.equal(r.json.verified, undefined);
  assert.equal(fakeCalls.length, n);
});
await check('without ?verify=wait the answer is immediate and says how many are being checked', async () => {
  const r = await post(det({ ...far(), image_url: 'https://img.test/f/flat.jpg' }));
  assert.equal(r.json.verifying, 1);
  await new Promise((ok) => setTimeout(ok, 1500)); // let the background check finish
});

console.log('POST /api/upload');
const up = (name: string, type = 'image/jpeg', bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) =>
  upload.POST(new Request(`${BASE}/api/upload?name=${name}`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes }));
await check('bad name → 400', async () => assert.equal((await up('../x.jpg')).status, 400));
await check('non-image → 415', async () => assert.equal((await up('a.jpg', 'text/plain')).status, 415));
await check('> 4 MB → 413', async () => assert.equal((await up('a.jpg', 'image/jpeg', new Uint8Array(4 * 1024 * 1024 + 1))).status, 413));
if (process.env.R2_ACCESS_KEY_ID) {
  await check('real upload → public URL that serves the bytes', async () => {
    const r = await body(await up('smoke-test.jpg'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.image_url, /\/frames\/smoke-test\.jpg$/);
    const got = await fetch(r.json.image_url);
    assert.equal(got.status, 200);
  });
} else {
  console.log('  skip real R2 upload (R2_* not set)');
}

console.log('timing');
await check('GET /api/potholes < 1 s (warm)', async () => {
  await potholes.GET(new Request(`${BASE}/api/potholes`));
  const t0 = Date.now();
  await potholes.GET(new Request(`${BASE}/api/potholes`));
  const ms = Date.now() - t0;
  console.log(`       (${ms} ms from this laptop)`);
  assert.ok(ms < 1000);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
fake.close();
