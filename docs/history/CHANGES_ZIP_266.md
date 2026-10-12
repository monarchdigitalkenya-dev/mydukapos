# Zip 266 - Payer name and code after STK push; Till opens on All

Everything in zip 265, plus:
- **Payer name and M-PESA code after an STK push.** The till now fetches them: Safaricom's Till confirmation (sent for an STK push too) is joined to the STK payment by M-PESA code, so the payer name appears in the Payer name box and the code in the M-Pesa code box. If the STK result never arrived, the one pending prompt with the same amount and the same payer phone (plain, or Safaricom's SHA-256 of it) is given the code and name from that confirmation; two candidates or no phone proof means nothing is guessed. The till waits up to two extra checks (about 6 s) for these before asking the cashier to type them.
- **Till screen.** Opens on All (was Unlinked). Every payment carries a source badge, DIRECT TO TILL or STK PUSH; a payment that came through both messages is one STK row with the name, never two. The waiting count still counts only direct payments nobody has matched.

No schema change. Needs Safaricom to deliver the Till (C2B) confirmation and the STK result to this app; if neither arrives, only the phone number is known.
