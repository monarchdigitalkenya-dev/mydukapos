# Product-card photos (zip 288)

**Current files were made from the sample board you shared** (`python3 tools/make-card-images.py <sample.jpeg>`): each card was cropped, its baked-in text painted out, and resized to 3:2. The sample is only ~490 px wide per card, so the 1200 px files are an upscale and look soft, and the left side is smoothed where text was removed (the dark overlay covers it). Replace them with real photographs when you have them, keeping the same file names.

The home page's seven product cards look for these files. Until a file exists the card shows its branded gradient (text stays readable).

| Product | Files (put in `public-site/img/`) | Show |
|---|---|---|
| shop | `card-shop-640.webp`, `card-shop-1200.webp` | Retail shelves, touchscreen POS, barcode scanner, checkout counter |
| hotel | `card-hotel-640.webp`, `card-hotel-1200.webp` | Restaurant interior, laid tables, warm lighting |
| hospital | `card-hospital-640.webp`, `card-hospital-1200.webp` | Clinician with a tablet in a clean ward |
| production | `card-production-640.webp`, `card-production-1200.webp` | Workshop / production line, raw materials, workers |
| pharmacy | `card-pharmacy-640.webp`, `card-pharmacy-1200.webp` | Organised medicine shelves, counter, terminal |
| services | `card-services-640.webp`, `card-services-1200.webp` | Phone repair, salon, garage, laundry collage |
| water | `card-water-640.webp`, `card-water-1200.webp` | Refillable bottles, commercial dispenser |

Specs: WebP, 3:2 (1200x800 and 640x427), subject on the RIGHT, the left ~55% calm (the text sits there), no watermarks, licensed for commercial use, ideally under 150 KB (large) / 60 KB (small).
The photo's focal point is set per card by `pos` in `public-site/product-cards.json` (default `right center`). Change the text, colours or alt text in that file, then run `npm run build:cards`.
Browsers pick the 640 px file on phones and the 1200 px file on large screens. Nothing loads from an outside service.
