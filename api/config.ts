// GET /api/config → small JS file with public browser settings from Vercel env vars.
// CARTO_KEY is a tile key the browser sends with every tile request, so it is visible
// to visitors anyway; keeping it in env just keeps it out of the public repo.
export function GET(): Response {
  const key = (process.env.CARTO_KEY || '').replace(/[^A-Za-z0-9_-]/g, '');
  return new Response(`window.CARTO_KEY = ${JSON.stringify(key)};\n`, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
