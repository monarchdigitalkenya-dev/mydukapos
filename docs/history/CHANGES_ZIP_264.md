# Zip 264 - Payment and sample fixes

Everything in zip 263, plus:


- **Aqua sample shows stock.** The Aqua sample seed keeps stock per site (`stock: {site-shop-1: qty}`, the app's default shop id), so tiles no longer all read "Out of stock" (`SEED_VERSION` 4 re-seeds the samples).
- **Production Sales Counter.** An empty `#sales-cart-slot` took a grid column and pushed the cart below the fold; it is hidden until the cart moves in (rule in the shared override block of every app).
- **Typed address when buying a link.** The buyer types an address, availability is checked live, and a taken one gets `-1`, `-2`... (`chooseSlug`). The link is created only after payment is confirmed; Paywave status is asked directly and counts only with a receipt number.

- **STK "still processing" after a paid prompt.** Safaricom's status query answering ResultCode 0 now marks the payment paid (receipt added when the callback arrives) instead of waiting for a callback that may never come; a failed late callback can no longer undo it. `get-my-link` accepts the same answer for Daraja (Paywave still needs a receipt).
