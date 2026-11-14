// POST /api/upload?name=<detection_id>.jpg   raw image body, Content-Type: image/jpeg
//   → { image_url: "<R2_PUBLIC_URL>/frames/<name>" }
// Same name again overwrites (retries are safe). Images must be < 4 MB.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { json, preflight } from './_lib/http';

const MAX_BYTES = 4 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpe?g|png|webp)$/i;
const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

let client: S3Client | null = null;

export async function POST(request: Request): Promise<Response> {
  const name = new URL(request.url).searchParams.get('name') ?? '';
  if (!NAME_RE.test(name))
    return json({ error: 'query ?name= must look like <detection_id>.jpg (letters, digits, . _ -)' }, 400);

  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return json({ error: 'Content-Type must be image/jpeg (or png/webp)' }, 415);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) return json({ error: 'image must be < 4 MB' }, 413);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) return json({ error: 'empty body' }, 400);
  if (body.byteLength > MAX_BYTES) return json({ error: 'image must be < 4 MB' }, 413);

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL)
    return json({ error: 'R2 env vars not set' }, 503);

  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  const key = `frames/${name}`;
  const ext = name.split('.').pop()!.toLowerCase();
  try {
    await client.send(
      new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: TYPES[ext] ?? type }),
    );
  } catch (err) {
    console.error('upload: R2 put failed', err);
    return json({ error: 'storage error, safe to retry' }, 503);
  }
  return json({ image_url: `${R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}` });
}

export function OPTIONS(): Response {
  return preflight();
}
