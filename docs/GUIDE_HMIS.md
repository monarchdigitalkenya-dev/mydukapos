# HMIS (Hospital) - separate system: beginner guide

## What you have
A complete copy of the Hospital / HMIS app that runs on its own, away from your MyDukaPOS system. It has its own address, its own databases and its own Owner Console. Nothing is shared with the other system, and you cannot damage one by working in the other. Your original system still has the HMIS app in it, untouched.

## What is inside
- **The Hospital app** (patients, consultations, pharmacy dispensing, billing, stock, reports). The same app as before, with the latest fixes.
- **Owner Console** at `https://YOUR-ADDRESS/owner/`: here you create the links for each hospital that uses the system.
- **Server code and databases** that save and sync each hospital's data between its devices.
- The address `https://YOUR-ADDRESS/` simply opens the hospital app.

## Day-one checklist
1. Follow `DEPLOY_HMIS.md` from step 1 to step 22.
2. Step 23 matters: open `/owner/` straight away and create the owner account, because whoever does it first owns the system.
3. Create a client link in the Owner Console for your first hospital (every link opens the hospital app).
4. Open the link on the hospital's devices and finish the first-time set-up (hospital name, admin password, staff).
5. Install it to the home screen so it works like an app, even with a weak connection.

## Good to know
- **It starts empty.** Clients and records in your old system are not copied. A hospital that already uses your old system keeps using it until you decide to move it.
- **Offline first:** devices keep working without the internet and sync when it returns.
- **Your own domain:** a name like `hmis.yourhospital.co.ke` can be attached later in the Cloudflare dashboard (Workers & Pages > mydukahmis > Custom domains). Ask me and I will give you the exact steps.
- **Backups:** run `npm run db:backup` before any update that changes the database.
- **Updates:** use the "UPDATING THE HMIS LATER" steps at the bottom of `DEPLOY_HMIS.md`.

## If something looks wrong
Tell me the step number and exactly what the screen said.
