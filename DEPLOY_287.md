# Zip 287 - deploy

Daraja audit (direct Till payments, STK push, notifications, labelling). One fix:

- Safaricom's Till message is ALSO sent for a payment made by STK push, and it can arrive a few seconds before the STK result. The live Till watcher could therefore announce an STK payment as "DIRECT TILL PAYMENT". A payment is now announced only on its second look (about 8 seconds later); if the STK result claims it meanwhile it is never announced. Real direct payments are still announced, with the payer's name and M-PESA code.
  Change: src/shared/blocks/till-payments.html (synced into every app).

Server side was reviewed and left unchanged: Till (C2B) confirmation, STK callback, idempotency on the M-PESA code, the key check on callbacks, the registered addresses (no "mpesa" in them), and the ledger.

Deploy as usual (router unchanged): DEPLOY_284.md steps 1-4 and 9-10, then npm run deploy:fast. Hard-refresh each app (Ctrl+F5).
