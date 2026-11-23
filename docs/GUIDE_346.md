# Guide - boxes, packets and pieces (zip 346)

Picture a box of sweets. Inside the box are packets. Inside each packet are single sweets. You can sell a whole box, one packet, or one sweet - and you want to count each of them on the shelf. This is how.

## The idea (one minute)
Every item keeps **one stock number in its smallest unit** (single sweets). Box and packet are just sizes: "1 Packet = 100 sweets", "1 Box = 12 packets = 1,200 sweets". Sell, receive or count at any level and the one number stays right.

## 1. Bring your list in from Excel
1. Open **Inventory** (the list). Tap **📥 Import boxes & packets (Excel)**.
2. Tap **Choose file** and pick your Excel file. Two kinds work:
   - **Your own list** with columns like *Whole/Carton/Bag*, *Pack/OUT/Dozen*, *Piece/Single* (text such as "1 case=6 bottles", "OUT= 6 pcs", "1 box of 12 pkts").
   - **The template** - tap **Download the blank template**, fill it, import it. (A ready-filled version of your own list is in the zip: `templates/Stock_List_ready_to_import.xlsx`.)
3. Check the screen:
   - **Ready** items need nothing.
   - **Missing something** items (yellow) - the file does not say how many packets are in a box, for example. Type the number in the box, or tick the row off to skip it. Same number for many? Type it in "Fill every EMPTY box size with ..." and tap the button.
   - Prices (optional): price of one piece, one packet, one box. Leave packet / box empty and they are worked out from the piece price.
4. Tap **Import now**. Items that already exist are not changed (their stock is never touched).

Items imported without a box size still work - add the size later: **Inventory > 📦 Package sizes**.

### Template columns (one row per item)
| Column | Meaning |
|---|---|
| Item name | required |
| Piece unit | smallest thing sold: pcs, bottle, sweet, kg |
| Pieces per packet / Packet name | leave empty if no packets |
| Packets per box | how many packets in one box |
| Pieces per box | only when the box holds pieces directly (a case of 24 bottles) |
| Box name | Box, Case, Bag, Crate ... |
| Piece / Packet / Box price | price of ONE of that level |
| Cost per piece / Cost per box | what you pay |
| Opening boxes / loose packets / loose pieces | what is on the shelf now (added together) |

## 2. Sell a box, a packet or a single sweet
At the **Sales Counter**, tap the item. A chooser shows each level you can sell (1 sweet, 1 Packet, 1 Box) with its price and how many are left. Pick one. Stock goes down by the right number of sweets.

## 3. Stock take at each level
1. Open **Stock Take** and search the item.
2. You see one box for each level, e.g. **Boxes (1200)**, **Packets (100)**, **Loose sweet**. Type what you counted of each: *2 full boxes, 3 loose packets, 5 loose sweets*.
3. Under the boxes you see the sum: `2 × 1200 + 3 × 100 + 5 = 2705 sweet`, and the difference to the system.
4. Choose a reason if there is a difference, then **Update stock**.
Tip: "count matches" fills the boxes from the system figure.

## Opening a box
Nothing to do: opening a box does not change the total. Count your loose packets and loose sweets as you find them.
