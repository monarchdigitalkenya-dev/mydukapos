# Zip 178 — Hotel/Restaurant import reads Sub-categories

* The Excel/CSV import (Inventory ▸ ⬆️ Import) has a new **Sub-category** column. It creates the category and, inside it, the sub-category (e.g. Milkshakes → 100 / 200), and puts each item in it. Sub-categories already show as chips on the Sales Counter.
* The same item name may exist once per sub-category (Camel Tea 80 and Camel Tea 150); importing the same file twice adds nothing.
* Headers are matched by name: Type, Category, Sub-category (also "Sub category", "Subgroup"), Name, Code, Selling price.
* `Menu_import.xlsx` (delivered separately, not in the zip) is your menu, ready to import. Test: `tests/zip178-import-subcategories.test.mjs`.
