# Zip 132 — The open HMIS items, radiology images, and "add item" without the camera

Zip 132 includes zip 131 (no sale ever hidden). No stored data is changed.

## 1. Add item: upload from the device only (all 6 apps with item photos)
The "📸 Use Camera" choice and the camera view are removed from ➕ Add Item / Add Medication. Opening the tab used to switch the
camera on every time; now there is only **🗂️ Upload from device**.
* It is a plain file picker. On a phone it shows the phone's photos and files.
* The photo is compressed as before (400 px, about 60 KB).
* **📸 Capture List**, which reads a photographed invoice, is a separate feature. It opens the camera only when you tap "Take
  Photo", and is unchanged.

## 2. Pharmacy and Cashier are two stations (Hospital)
* **💳 Cashier / Counter** (the existing counter tab):
  * the Cashier queue;
  * loads the patient's bill and takes payment;
  * stock comes off at payment, exactly as before.
* **💊 Pharmacy (Dispensing)** (new tab):
  * the Pharmacy queue;
  * **Medicines ready to dispense**: every paid, or billed, prescription not yet handed over;
  * **✔ Dispensed**: who and when, recorded in the patient's journey and the audit log;
  * **✖ Not collected**: a reason is required, and the medicine stays paid, so return it to stock with Returned Goods;
  * **Dispensed today**.
* **The flow:** the clinic suggests Pharmacy. If the medicine is unpaid, the Pharmacy shows "Not paid yet" and **💳 Send to
  Cashier**. After payment, "Send to…" suggests **Pharmacy**. When everything is dispensed, it suggests Discharge.
* **Also:**
  * the Hospital Report's "Needs attention" shows patients waiting to collect medicines;
  * the Pharmacist role now includes the Pharmacy tab;
  * medicines paid before this release are not listed as waiting.

## 3. Appointments: search, not a list of every patient
The appointment form uses the same search-first patient picker as Reception, Lab and Radiology.

## 4. Void and discount requests, approved by a manager (Hospital)
* **Void:** in Daily Sales a cashier gives the reason and chooses **send to a manager** (or a manager enters the password there,
  as before). Nothing changes until approval. The approved void then runs as before: stock comes back and the charges reopen.
  The reason records who requested it and who approved it.
* **Discount:** tapping the cart total to quote a lower price offers **ask a manager**, with a reason required. The counter shows
  "⏳ waiting", then "✅ approved — Apply" (it can be approved from any device), or "❌ rejected".
  * The approval applies only to the **same, unchanged cart**, and only **once**.
* **Approvals:** managers approve or reject (a rejection needs a reason) in **💵 Cashier Shift ▸ ✅ Approvals — voids & discounts**.
  * The requester cannot approve their own request unless they are the Admin.
  * Everything is in the audit log.
  * "Needs attention" counts waiting requests.

## 5. Cancelled charges are not "Unpaid"
In a patient's billing history, a cancelled or not-carried charge is marked as such, and no longer makes a bill "Unpaid" or
"Partially paid" or adds to its total.

## 6. Radiology images, compressed on upload (Hospital)
* **🖼️ Add images** on any imaging order. The images come from the device (JPEG / PNG exports, or photos of the film), never the
  camera, and several can be added at once.
* **Compressed on the device before upload:** at most 1600 px and about 350 KB each. In real Chromium a 17 MB, 4000×3000 image
  came out as a 1600×1200 JPEG of 347 KB.
* **Kept on the device first** (IndexedDB), then uploaded:
  * offline, or on a failed upload, it waits and is retried every 30 s and when the connection returns;
  * each image shows ⏳ uploading or ⚠ not uploaded until it is on the server.
* **Viewable on any device** (🖼️ 1, 2 …), with a download button.
* **✕ Remove** needs a reason, which is kept in the audit log.
* **Storage:** each image is stored under its own key in the shop's own KV store, through a new `/api/radiology-image`
  endpoint. It uses the same licence and paired-device rules, and a shop can never read another shop's images.
  * The imaging order syncs only the list of images (id, size, who, when). The pictures never ride along with every sync.
* **Two devices adding images to the same order at once keep both.** The server now merges the image list by id. **Database
  shops need `npm run deploy:router`** for this part.
* **Limits:**
  * This is not a PACS / DICOM viewer.
  * Each image is capped at ~1.1 MB on the server.
  * Cloudflare KV storage counts toward the account's KV quota, roughly 3,000 images per GB.

## Tests
`tests/zip132.test.mjs` (15 tests), plus the full suite in the Kenya time zone:
* add item without the camera, in all 6 apps;
* the Pharmacy / Cashier flow end to end (stock taken once), and "not collected";
* the appointment search;
* a void request, approved and rejected (stock returned once);
* a discount request: applied once, refused on a changed cart;
* the cancelled-charge label;
* the image endpoint (per shop, idempotent, size and type checks, delete);
* images on the device: offline, then uploaded, viewable, not in the synced order;
* the image-list merge.
