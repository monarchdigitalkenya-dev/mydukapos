// functions/llms.txt.js — /llms.txt (zip 177): a plain-text summary for AI assistants and crawlers. Public facts only, and it points at the pages.
import { isApexRequest, PRODUCT_PAGES, DEFAULT_SITE_ORIGIN } from './_site.js';
export async function onRequestGet({ request, env }) {
  if (!isApexRequest(request, env)) return new Response('Not found', { status: 404 });
  const o = new URL(request.url).origin || DEFAULT_SITE_ORIGIN;
  const body = `# mydukapos

> Point-of-sale software for Kenyan businesses that keeps selling without internet and syncs when it returns. Runs in the browser, on Windows and on Android.

## Products
${Object.entries(PRODUCT_PAGES).map(([k, p]) => `- [${p.name}](${o}/products/${k}): ${p.description}`).join('\n')}

## Pages
- [Home](${o}/): overview and current pricing
- [Offers](${o}/offers): current timed offers
- [FAQ](${o}/faq)
- [Contact](${o}/contact)
- [Terms](${o}/terms), [Privacy](${o}/privacy), [Cookies](${o}/cookies), [Acceptable use](${o}/acceptable-use)

## Not for indexing
Shop apps, the owner console and /api are private and require sign-in.
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
