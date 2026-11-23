# Zip 288 - deploy

SEO + product cards.
1. Sitemap/robots: /sitemap.xml is one flat file (17 public URLs, canonical https://mydukapos.store, no priority/changefreq/lastmod). robots.txt names it. Files: functions/_site.js, sitemap.xml.js, robots.txt.js.
2. Product pages now carry their real heading/summary/image alt and breadcrumb schema in the served HTML (functions/_middleware.js). /shop has a static h1 and intro.
3. Home page: the 7 product cards are in the served HTML (crawlable links), generated from public-site/product-cards.json (`npm run build:cards`; `npm run check` fails if out of date). Photos: see docs/CARD-IMAGES.md (none included; gradients show until added).
4. Owner Console -> Content -> SEO: sitemap centre, Search Console copy-and-submit guide, site audit, page inventory, Google connection, performance. API: functions/api/owner-seo.js (owner session only, rate-limited).
5. Optional Google connection: secret GSC_SERVICE_ACCOUNT_JSON (wrangler pages secret put GSC_SERVICE_ACCOUNT_JSON --project-name=mydukapos), variable GSC_SITE_URL (default sc-domain:mydukapos.store). Add the service-account e-mail as a user of the property in Search Console.
6. Live-demo gallery: all 9 demos now show a picture (public-site/img/demo-<key>.webp, 800x450). Seven are photos from the sample (tools/make-demo-photos.py); Hardware and Liquor are DRAWN scenes (tools/make-demo-scenes.py), not photos: replace demo-hardware.webp / demo-liquor.webp with real photos when you have them. The gallery images are now truly 16:9 (they were forced to 4:3 by the height attribute).
7. Cloudflare dashboard (not code): add a redirect rule www.mydukapos.store/* -> https://mydukapos.store/$1 (301).

Deploy: npm install, npm test, npm run check, then npm run deploy (router unchanged). After deploy run: node tools/seo-check.mjs
Known: tests/zip180-sales-counter.test.mjs test 4 also fails on zip 287 (not caused by this zip).
