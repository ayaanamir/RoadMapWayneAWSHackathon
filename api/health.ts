// GET /api/health → { "ok": true }   (contract v3)
import { json, preflight } from './_lib/http';

export function GET(): Response {
  return json({ ok: true });
}

export function OPTIONS(): Response {
  return preflight();
}
