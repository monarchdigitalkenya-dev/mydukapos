# Restock guide (zip 349)

## What was wrong
If you restocked an item that has variants (for example a shirt that comes in Red and Blue) by typing the item's MAIN name, the app refused it, but then showed a green "Restock recorded" message on top of the warning. Nothing was added to stock and a KES 0 expense was logged.

## What happens now
- **Nothing could be added:** you see a red message telling you to restock each variant by its own code. Nothing is recorded or printed, and your rows stay on screen so you can fix them.
- **Some rows added, some refused:** you see "Restock recorded..." in red with the names of the items that were NOT added. Only the items really added count as the expense.

## How to restock an item that has variants
1. Open the Restock tab.
2. In the Code box type the variant's own code (for example Polo - Red), or search for the variant by name.
3. Type the quantity and the cost price, then press Complete Restock.
4. Repeat for each colour or size you received (one row each).

## Check it worked
Open Inventory. The variant's quantity went up, and the main item's total is the sum of its variants.
