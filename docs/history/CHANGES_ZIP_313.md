## Zip 313 - Loyalty tokens on the receipt; Business HQ always in the side menu

- **Receipt:** when loyalty tokens are on and the sale has a customer (phone), the receipt shows a LOYALTY TOKENS block: **Earned this sale** (+5), **Token balance** after the sale (15) and, when a token has a value, **Balance worth** (KES 30.00). Printed, on screen, PDF and reprints alike; a reprint shows the figures as they were at that sale. Hotel member multipliers are counted (earned = balance after minus before).
- **Option:** Settings > Loyalty > "Show tokens earned and the token balance on the receipt" (on by default, synced to every device of the shop). Shop, Hotel, Pharmacy, Hospital, Water, Services.
- **Business HQ** now has its own line in the side menu, just above the signed-in person, on every page, for whoever is signed in. It sits outside the menu list (which redraws often) and is put back at once if the menu is rebuilt. The Staff-tab button stays as well.
- Shared functions `loyaltyBalanceOf`, `loyaltyStampSale`, `receiptLoyaltyLines`, `setReceiptShowLoyalty`. Test `zip313-receipt-loyalty` (a real Shop checkout + the other 5 apps). Service worker zip-313.
