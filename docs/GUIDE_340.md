# Guide for zip 340 (beginner friendly)

Everything below is already inside the app. Nothing is deployed for you; follow DEPLOY_340.md to publish.

## 1. Moving stock: Store and Inventory (answers "does it fill the existing item?")
**Yes.** Store tab > **Move** > "Store to Inventory" adds the number to the item that already exists, in the right size. It finds the item by size id, size code, `Name (Size)` or plain name, so a new item is never created.
- Four ways in the Move button: Store to Inventory, Inventory to Store, Store to a branch, a branch to Store.
- **Old duplicates** like "Beige Normal shirt (XL)": go to Inventory and press **Match extra items to sizes**. For each one it shows "Extra item / Stock / Is really" (for example Beige Normal shirt, XL). Press **Match** on one, or **Match all** (one confirmation). The stock is added to the real size and the extra item disappears.

### Inventory Move (same four ways, from the Inventory tab)
Every Inventory row has a **↔ Move** button (and every size of a variant item). Choose:
1. **Inventory → Store**: sends some of this item to the Store.
2. **Inventory → another branch**: sends it to another branch (shows "in transit" until they confirm).
3. **Store → this item**: pulls stock out of the Store **into this exact item and size**. Nothing new is created.
4. **Another branch → Store**: asks the other branch to send it. Nothing moves until they press Send.
Pressing Move twice never moves it twice.

## 2. Patient age
Registration: type the date of birth, or choose **Enter age** and give Years, Months or Days (babies).

## 3. Maternal & Child Health
A new group in the left menu. All old pages are still there.

## 4. Consultation workspace (Hospital)
Open a patient > Consultation. The window fills about 95% of the screen. The top shows **allergy** and **vitals** (red/amber "not recorded" if missing, never shown as normal). Write notes as Subjective, Objective, Assessment, Plan; old notes stay visible under "Earlier notes".
- **Save draft** keeps your work on this device. **Save visit** finishes it. **Save & send to cashier** also sends the bill; pressing twice never charges twice.
- Medicines: choose **Take-home**, **IM**, **IV**, **SC** or **Given in clinic**. Medicines given in the clinic can carry an **Administration fee**.
- Lab tests can be requested without a diagnosis ("Diagnosis pending").
- Disposition (go home, admit, refer, lab) is at the end.

### Setting up services and fees (one time)
1. Inventory > Add item > type **Service**: create *Wound dressing*, *Injury care*, *Family planning* with your own prices (none are pre-filled).
2. On a service, **Consumables used**: pick the stock items (for example Gauze x 2). They are taken from stock **once**, when the service is marked **Performed**.
3. On a medicine, **Administration fee** (KES). It is charged only when the medicine is given in clinic, is not part of stock value, and is not charged for take-home.

## 5. M-PESA Agent (Shop app, Money menu: "📲 M-PESA Agent")
Your own books for agent work. It keeps two balances in whole shillings: **cash in the till** and **M-PESA e-float**. It does not connect to or get confirmation from Safaricom; the slip says so.
1. First time: **Settings** tab > type opening cash and opening float > the commission table (what you earn per size of transaction, from your agent agreement) > **Save settings**.
2. **Deposits**: customer gives cash, you send float. Cash goes up, float goes down. **Withdrawals**: the opposite.
3. **Float Management**: Buy float, Sell float, Cash in (bring cash to the till), Cash out.
4. Mistake? **Transaction History > Reverse** (manager, or someone given the permission) adds an opposite entry with a reason. The original stays visible, marked Reversed. Entries are never edited or deleted.
5. A transaction that would take cash or float below zero is blocked. A manager can override with a typed reason; it is marked **Override**.
6. **Reconciliation & Closing**: count the till, read the float, type both. The app shows the difference. A difference needs a manager's approval. Managers can post an **Adjustment** with a reason.
7. **Staff & Permissions**: a person needs the tab ticked in their roles to use it. Managers can tick extra rights: Reverse, Adjust, Post below zero, Approve closings. The server checks these too.
8. Works offline. Entries show **Pending sync** until they reach the server; two devices posting at once both survive, and any resulting minus balance is flagged for review.
9. History has filters, a daily summary and **CSV** download. Deposit and withdrawal slips use your normal receipt printer.
Capacity: each entry is tiny (about 200 bytes), so thousands per year are fine. Nothing is archived automatically.

## 6. HMIS look
Cleaner side menu (wider so long names fit), consistent tables and forms, no sideways scrolling at laptop, tablet or phone sizes.

## Known limits
- Drafts of consultations are saved per device (not synced).
- The Water app's Store matching was not changed.
