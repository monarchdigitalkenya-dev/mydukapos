// functions/api/public-demo.js — Cloudflare Pages Function
//
// RETIRED (zip 262). This was the anonymous "generate a demo" endpoint of the public website: it created a new demo shop for every visitor.
// The website now offers shared, pre-loaded live demos (functions/api/shared-demos.js), so nothing is created per visitor. The route stays only to
// answer old pages and bookmarks with a clear message instead of a 404 - it reads and writes nothing.

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS_HEADERS }); }

export async function onRequestPost() {
  return new Response(JSON.stringify({ error: 'Demos are now shared and open to everyone. Visit the website and press "Try Live Demo".', code: 'demo_generation_retired' }), {
    status: 410, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
