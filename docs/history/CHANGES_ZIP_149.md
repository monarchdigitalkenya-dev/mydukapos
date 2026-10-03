# Zip 149: Electron update

* `native/windows/package.json`: Electron ^31.7.7 -> ^44.4.5 (latest stable, 44.4.5). electron-builder stays at ^26.15.3 (already latest).
* No code changes were needed in main.js / preload.js: every API used still exists in Electron 44.
* Shop data is untouched: the storage partition (`persist:mydukapos-<app>`) and the app id are unchanged, so installing the new
  version over the old one keeps the sales stored on that computer.
* Verified: `npm run check` (shared code in sync), Windows app syntax check, and 72 sales/sync/bill tests, all passing.
* NOT verified here: the Windows installers themselves. Push to GitHub and let the `windows` workflow build and install-test them.

## Money audit
* FIXED (index.html, hotel, pharmacy, production, services): a CARD sale whose cart mixed in another branch's items saved the
  FULL card total on this branch's own sale record, so the other branch's money was counted here too (Daily Sales, X/Z, owner totals).
  Cash and M-Pesa were already scaled; card now is too. Test: tests/cross-branch-card-split.test.mjs.
* Known, left as is: VAT is computed per line without rounding and only rounded when shown, so on a receipt the displayed
  net + VAT can differ from the gross by 0.01. The gross (what the customer pays) is always exact.
* Known, left as is: cross-branch cash/M-Pesa shares are each rounded to cents, so across several branches they can differ from the total by 0.01.
