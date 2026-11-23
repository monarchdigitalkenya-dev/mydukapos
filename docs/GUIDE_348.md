# Guide 348 - Aqua made simple (for beginners)

## 1. Adding a material (6 steps)
Materials tab > "Add material variety".
1. Material name, for example "Grip plain 500ml". Pick what it is: Bottle, Cap, Seal, Label or Wrapping.
2. Code (optional).
3. Item it is used for: tick the size(s) (500ml, 1000ml ...) and the type(s): Sealed bottle, Normal bale/case, Custom bale/case. Example: Grip plain 500ml ticked for 500ml + sealed bottle + normal bale. From then on it shows in the Bottle drop-down when you produce those.
4. Cost: type the price and choose "per bag" (then type how many pieces are in a bag) or "per piece". The screen shows the price of one piece.
5. Quantity available: full bags and loose pieces.
6. Save.
Later stock changes: use Restock (new delivery) or Adjust (a count correction) so the history stays correct. Editing never changes stock.

## 2. Importing the material list (CSV)
Materials tab > Import CSV. Use `templates/aqua_materials_sample.csv` (your list) or "Download CSV" to get your current materials, edit in Excel, import again. Existing materials (same name and type) are updated, new ones added, stock is never touched on re-import. Blank prices are allowed: fill them later.
Columns: Material name, Code, Type, Sizes, Used for, Cost, Cost per, Pieces per bag, Bags in stock, Loose pieces in stock. Several sizes or types are separated with ";" (500ml;1000ml).
Note: if an item (for example an 18.9L sealed bottle) does not exist as a product yet, the material waits and connects by itself when you create that item.

## 3. Producing (9 steps)
Production tab. Make sure the top switch says Production.
1. What are you producing (sealed bottle or bale/case) and how many.
2. Client (optional). If the client has a saved bottle it is filled in, and you can change it.
3. Bottle  4. Seal  5. Cap  6. Label  7. Wrapping (bales only) - drop-downs show only the materials linked to that size and type, with stock and cost.
8. Water - choose the production tank. It shows the level; the run uses (size x bottles) litres. A tank can be unlimited (level not tracked) or have a size. "New production tank" creates one; "Add water" tops it up. Production tanks are never used for refill sales.
9. Any other material (optional) - add anything else used.
The summary shows the cost. "Record production" checks everything first: if anything is short (water or a material) nothing changes. A wrong run can be reversed (Admin) from production history: materials and water return.
To remember a client's bottle: tick the box that appears under the Bottle step, or use Materials > Client bottles.

## 4. Price list and invoices
Price List & Invoices tab (Money group).
- Price list: standard, or for one client (type their special prices; empty = standard). Print/Save as PDF or copy for WhatsApp.
- Invoices: New invoice > client, items (prices fill in from the client's price, bale tiers or standard), discount, delivery, paid so far. Save, then print/share. Record payments later; Void keeps the number.
Invoices are documents; they do not change stock or sales totals.

## 5. Custom bale orders
Custom orders still use their own panel on the Production tab; their materials come from the items ticked "Custom bale/case".
