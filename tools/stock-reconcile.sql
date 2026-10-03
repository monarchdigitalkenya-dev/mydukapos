-- tools/stock-reconcile.sql  (zip 186)  READ-ONLY stock reconciliation for the D1 side after the retry-storm incident.   Brief task E.
-- Run:  npx wrangler d1 execute mydukapos-ledger --remote --file=tools\stock-reconcile.sql --json > backup\stock-reconcile.json
-- Nothing here writes. The correction at the bottom is a COMMENTED template: it is never applied automatically and needs the owner's approval.
--
-- WHAT D1 HOLDS (and what it does not):
--   * ledger_records kind='stock_move' : one row per stock movement id sent by the tills (data = the movement: code, delta, type, reason, unit ...). This is a MIRROR for audit
--     and reports; the shop's LIVE quantity is in its shop record (KV or the shop's own database) and is changed once per movement id by the stock ledger (applyStockLedger).
--   * ledger_sale_items               : the lines of every sale (qty sold per code).
--   * store_items / store_movements   : the shared WAREHOUSE store (keyed by group_id, not client_id). qty is never below zero (CHECK).
--   So: "stock below zero" for a SHOP can only be seen in the app / GET /api/stock-integrity?c=<link> (figures + problems), or Owner Console > Health ("items below zero").
--   The queries below find what D1 can prove: movements that disagree with the sales, and warehouse items whose quantity disagrees with their own movement history.
-- Edit the values in the WITH p(...) lines of section 1 (tenant + barcode). Sections 2-5 cover every tenant / group.

-- 1a. ONE shop, ONE barcode: D1 movements by reason (delta is negative when stock leaves)
WITH p(client_id, code) AS (SELECT 'kw8mqf3dkt', '8991389410365')
SELECT json_extract(r.data, '$.reason') AS reason, json_extract(r.data, '$.type') AS type, json_extract(r.data, '$.unit') AS unit, COUNT(*) AS movements, SUM(json_extract(r.data, '$.delta')) AS net_delta
FROM ledger_records r, p WHERE r.client_id = p.client_id AND r.kind = 'stock_move' AND json_extract(r.data, '$.code') = p.code
GROUP BY 1, 2, 3 ORDER BY movements DESC;

-- 1b. ONE shop, ONE barcode: sold quantity from the sales themselves, and what the Sale movements say. They should be opposite numbers (net_delta = -qty_sold)
WITH p(client_id, code) AS (SELECT 'kw8mqf3dkt', '8991389410365')
SELECT
  (SELECT SUM(i.qty) FROM ledger_sale_items i JOIN ledger_sales s ON s.client_id = i.client_id AND s.sale_id = i.sale_id WHERE i.client_id = p.client_id AND i.code = p.code AND s.status = 'COMPLETED') AS qty_sold_in_sales,
  (SELECT SUM(json_extract(r.data, '$.delta')) FROM ledger_records r WHERE r.client_id = p.client_id AND r.kind = 'stock_move' AND json_extract(r.data, '$.code') = p.code AND json_extract(r.data, '$.reason') = 'Sale' AND COALESCE(json_extract(r.data, '$.unit'), 'qty') = 'qty') AS sale_movements_net_delta,
  (SELECT COUNT(*) FROM ledger_records r WHERE r.client_id = p.client_id AND r.kind = 'stock_move' AND json_extract(r.data, '$.code') = p.code) AS movements_total
FROM p;

-- 1c. ONE shop, ONE barcode: every movement, newest first (the incident record is 1790947028363-b7nq9rpt9k)
WITH p(client_id, code) AS (SELECT 'kw8mqf3dkt', '8991389410365')
SELECT r.rec_id, json_extract(r.data, '$.timestamp') AS at, json_extract(r.data, '$.delta') AS delta, json_extract(r.data, '$.type') AS type, json_extract(r.data, '$.reason') AS reason,
  json_extract(r.data, '$.by') AS by_user, (SELECT COUNT(*) FROM ledger_audit a WHERE a.client_id = r.client_id AND a.kind = 'stock_move' AND a.rec_id = r.rec_id) AS audit_rows
FROM ledger_records r, p WHERE r.client_id = p.client_id AND r.kind = 'stock_move' AND json_extract(r.data, '$.code') = p.code
ORDER BY r.ts DESC LIMIT 100;

-- 2. EVERY shop: items whose Sale movements disagree with the sales (|net_delta + qty_sold| above 0.001). A movement applied twice shows up as net_delta below -qty_sold.
--    (The movement log of a shop is capped and archived by the app, so an old item can differ for innocent reasons: look at the biggest differences first.)
WITH mv AS (
  SELECT client_id, json_extract(data, '$.code') AS code, SUM(json_extract(data, '$.delta')) AS net_delta, COUNT(*) AS n
  FROM ledger_records WHERE kind = 'stock_move' AND json_extract(data, '$.reason') = 'Sale' AND COALESCE(json_extract(data, '$.unit'), 'qty') = 'qty' GROUP BY client_id, code
), sold AS (
  SELECT i.client_id, i.code, SUM(i.qty) AS qty_sold FROM ledger_sale_items i JOIN ledger_sales s ON s.client_id = i.client_id AND s.sale_id = i.sale_id
  WHERE s.status = 'COMPLETED' GROUP BY i.client_id, i.code
)
SELECT mv.client_id, mv.code, mv.n AS sale_movements, mv.net_delta, COALESCE(sold.qty_sold, 0) AS qty_sold, ROUND(mv.net_delta + COALESCE(sold.qty_sold, 0), 3) AS difference
FROM mv LEFT JOIN sold ON sold.client_id = mv.client_id AND sold.code = mv.code
WHERE ABS(mv.net_delta + COALESCE(sold.qty_sold, 0)) > 0.001
ORDER BY ABS(mv.net_delta + COALESCE(sold.qty_sold, 0)) DESC LIMIT 100;

-- 3. EVERY shop: movements that were written to the audit more than once (the retry storm). After migration 0007 + the server fix this list stops growing.
SELECT client_id, kind, rec_id, COUNT(*) AS audit_rows FROM ledger_audit WHERE id > (SELECT COALESCE(MAX(id), 0) - 200000 FROM ledger_audit)
GROUP BY client_id, kind, rec_id HAVING COUNT(*) > 20 ORDER BY audit_rows DESC LIMIT 50;

-- 4. WAREHOUSE (every group): the quantity of each item against its own movement history.
--    expected = the quantity before the first movement + every signed movement (ADD and QTY add qty, TRANSFER_OUT subtracts it unless it was CANCELLED, others 0)
--    last_qty_after = what the newest movement says the quantity became. Both should equal store_qty. (Items migrated from the old KV store start with no movement: they show a difference
--    of exactly their opening quantity in expected, not in last_qty_after.)
WITH sm AS (
  SELECT group_id, item_id,
    SUM(CASE WHEN kind IN ('ADD', 'QTY') THEN qty WHEN kind = 'TRANSFER_OUT' AND status <> 'CANCELLED' THEN -qty ELSE 0 END) AS signed_sum,
    COUNT(*) AS movements
  FROM store_movements WHERE item_id IS NOT NULL GROUP BY group_id, item_id
)
SELECT i.group_id, i.item_id, i.code, i.name, i.qty AS store_qty, sm.movements,
  (SELECT m.qty_after FROM store_movements m WHERE m.group_id = i.group_id AND m.item_id = i.item_id AND m.qty_after IS NOT NULL ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS last_qty_after,
  COALESCE((SELECT m.qty_before FROM store_movements m WHERE m.group_id = i.group_id AND m.item_id = i.item_id AND m.qty_before IS NOT NULL ORDER BY m.at, m.rowid LIMIT 1), 0) + COALESCE(sm.signed_sum, 0) AS expected
FROM store_items i LEFT JOIN sm ON sm.group_id = i.group_id AND sm.item_id = i.item_id
WHERE i.archived = 0 AND (
  ABS(i.qty - COALESCE((SELECT m.qty_after FROM store_movements m WHERE m.group_id = i.group_id AND m.item_id = i.item_id AND m.qty_after IS NOT NULL ORDER BY m.at DESC, m.rowid DESC LIMIT 1), i.qty)) > 0.0005
  OR ABS(i.qty - (COALESCE((SELECT m.qty_before FROM store_movements m WHERE m.group_id = i.group_id AND m.item_id = i.item_id AND m.qty_before IS NOT NULL ORDER BY m.at, m.rowid LIMIT 1), 0) + COALESCE(sm.signed_sum, 0))) > 0.0005
  AND sm.movements IS NOT NULL
)
ORDER BY i.group_id, i.name LIMIT 200;

-- 5. WAREHOUSE: transfers still IN_TRANSIT (stock left the store, not yet received) - these explain a store_qty that is lower than a shop expects
SELECT group_id, dest_client_id, item_name, qty, at FROM store_movements WHERE kind = 'TRANSFER_OUT' AND status = 'IN_TRANSIT' ORDER BY at LIMIT 200;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- PROPOSED CORRECTION TEMPLATE (warehouse only). NOT APPLIED. Copy it to a separate file, replace the CAPS values from the report above, get the owner's approval, THEN run it:
--   npx wrangler d1 execute mydukapos-ledger --remote --file=backup\approved-correction.sql
-- It records the fix as a normal 'QTY' movement (history kept, nothing deleted) exactly like the app's own quantity correction, and sets the quantity in the same transaction.
--
--   INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, detail)
--     SELECT group_id, 'fix-186-GROUP-ITEM', 'QTY', item_id, name, unit, NEWQTY - qty, qty, NEWQTY, 'DONE', 'owner-approved', strftime('%s','now') * 1000, 'Reconciled after the audit retry storm (zip 186): NEWQTY'
--     FROM store_items WHERE group_id = 'GROUP' AND item_id = 'ITEM' AND qty <> NEWQTY;
--   UPDATE store_items SET qty = NEWQTY, updated_at = strftime('%s','now') * 1000 WHERE group_id = 'GROUP' AND item_id = 'ITEM' AND qty <> NEWQTY;
--
-- A SHOP's live stock (kw8mqf3dkt / 8991389410365) is NOT corrected in D1: do a stock take of that item in the app (a count is absolute and recorded once), or review
-- the figure with GET /api/stock-integrity?c=<link> first. The server applies each movement id exactly once, so a re-sent movement never changed the figure: confirm that with 1b/1c
-- (one movement row, audit_rows = 1 after the fix) before deciding anything.
