# Deploy zip 324 - Import keeps the selling price (includes everything up to 323)

Zip 324: closes the two remaining ways an imported price could look fine in the review window and still be 0 afterwards.
No database change. The router does not need deploying. Service worker version: zip-324.

What changed (Shop, Hospital, Hotel, Pharmacy, Production, Services):
- When the columns have to be picked by hand ("Match your columns" window), you can now also pick the Selling Price and the Wholesale Price column. Before, only Name / Quantity / Unit Cost could be picked, so the selling price was always 0.
- Press Batch Commit with a NEW item that has no Retail price: the review window now stops once and says how many items would be saved with price 0. Type the price in the Retail box, or press Batch Commit again to save them anyway. Items that already exist in the shop and items with sizes are not affected.

Deploy (Windows cmd, same as zip 323): unzip to C:\dev\zip324, robocopy into C:\dev\mydukapos as in DEPLOY.md, then
  npm run check
  node --test tests\zip324-import-price-guard.test.mjs   (must say: pass 12, fail 0)
  npm run deploy:fast
Then: Inventory > Import from Excel/CSV with a new item and no price. The warning appears; type a price in Retail, Batch Commit, and Inventory shows that price.
