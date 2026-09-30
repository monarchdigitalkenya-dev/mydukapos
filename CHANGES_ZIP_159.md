# Zip 159
Full details: `CHANGES_ZIP_159_HOTEL.md` (hotel categories, category chips on Sales Counter and Service Orders, Excel/CSV import),
`EFFICIENCY_REPORT_ZIP_159.md` (Cloudflare efficiency + the D1 write fence that fixes the chaos-test lost-sales race),
`CHANGES_ZIP_159_FIXES.md` (tank refill-log merge, produced-item returns).
Also fixed during the final regression: `functions/api/_media.js` returned 304 for plain image reads when the R2 object had no stream.
