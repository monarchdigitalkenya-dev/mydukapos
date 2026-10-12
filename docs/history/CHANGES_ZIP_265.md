# Zip 265 - Till shows STK push payments

Everything in zip 264, plus:
- **Till shows STK push payments too.** Sales Counter -> Till now lists payments confirmed through an STK push (Daraja, Paywave and the others) beside direct Till payments: tagged STK PUSH, with the payer's phone, receipt (or "Receipt pending" until the callback adds it), amount and time, and the customer's name when that phone is one of the shop's saved customers (Safaricom sends no name for an STK push). A new STK push chip filters them; they are records only, never counted as waiting and never matchable.

Storage: STK rows go in the existing `till_payments` table with status `STK` (no schema change, no migration). Older deployments with no D1 keep the previous direct-only list.
