# Zip 286 - deploy

1. Upgrade to permanent by M-Pesa prompt (STK push). On the lock / upgrade screen of a trial link, when the owner's payment gateway is set up (owner account -> Settings -> Payment Gateway), a box "Pay KES X by M-Pesa prompt" appears above the manual instructions. The shop types its number, gets the prompt, and upgrades by itself once the money is received. With no gateway the screen is unchanged ("I've made this payment", the owner confirms). New: functions/api/license-upgrade.js and functions/api/_upgrade.js (the owner's Confirm button now uses the same helper).
   The price charged is the ONE billing quote (Owner Console -> Billing). Keep it equal to the price shown in the manual text (Website content -> price).
2. Sell at the bar: shots / doubles / keg servings are always offered and listed first; the quantity can be typed as a fraction (0.5, 1.5, 0.25) and there is a +1/2 button.
3. Public portfolio: "Mogue" is now "Mugwe" (page, search/social text, llms.txt). The photo file name /img/samuel-mogue.jpg is internal and unchanged.
4. Carried from 285: licence popup closes only with X; hotel Bar & Kegs tab no longer blank.

Deploy order: router is unchanged (skip deploy:router). Steps: see DEPLOY_284.md 1-4 and 9-10, then npm run deploy:fast. Hard-refresh each app afterwards (Ctrl+F5).
