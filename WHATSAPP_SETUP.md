# WhatsApp → Leads (Owner Console)

Every person who starts a chat with your business WhatsApp number **by clicking your Meta (Facebook / Instagram) Click-to-WhatsApp ad** becomes a lead on the Owner Console's **Leads** tab
(name from their WhatsApp profile, phone number, the ad's headline and their message in the notes). **Ordinary texts that did not come from an ad are ignored** — they are never stored
and never become leads. A person who came from an ad and then writes again stays one lead: their new messages are added to it. The leads appear in the CRM
(source Meta ads, with the ad attribution); the old Owner Console Leads tab is retired.

## What it costs
* **The POS side: nothing.** It runs on the same Cloudflare Pages Functions as the rest of the system.
* **Meta (WhatsApp Business Platform):** no platform fee, and **messages customers send to you are free**. Charges only apply to messages *you* send through the API
  (marketing / utility templates, and — from 1 October 2026 — free-form replies inside the 24-hour window, at per-message rates that depend on the country).
  If you reply from your phone, not through the API, this feature adds no cost. Check Meta's current price list for Kenya before you start sending through the API.

## One-time setup (about 30 minutes)
1. Go to <https://developers.facebook.com> → **My Apps → Create App** → type **Business** → add the **WhatsApp** product.
2. Add your number **+254 791 598 506** under *WhatsApp → API Setup → Add phone number*. A number that is already used in the normal WhatsApp / WhatsApp Business
   phone app has to be moved to the API first (Meta explains the options on that screen, including keeping the Business app alongside — confirm what it offers for your number).
3. In Cloudflare (Pages → your project → **Settings → Variables and secrets**) add two secrets:
   * `WHATSAPP_VERIFY_TOKEN` — any long random text you make up (e.g. 30 random letters).
   * `WHATSAPP_APP_SECRET` — the **App Secret** from Meta (*App settings → Basic*).
   Then redeploy (`npm run deploy`).
4. In Meta: *WhatsApp → Configuration → Webhook → Edit*:
   * Callback URL: `https://<your Owner Console domain>/api/whatsapp-webhook` (for example `https://mydukapos.store/api/whatsapp-webhook`)
   * Verify token: the same text as `WHATSAPP_VERIFY_TOKEN`
   * Click **Verify and save**, then **Manage** and subscribe to **messages**.
5. Test it: open your ad (or its preview link) on another phone and tap the WhatsApp button, then send a message. Open the Owner Console → **Leads**: that person is there. A plain message to the number that did **not** come from an ad is deliberately ignored.
6. The ad must be a **Click-to-WhatsApp** ad (objective: Engagement / Sales → message destination: WhatsApp) — only those carry the marker that tells the system the chat came from an ad.

## Safety
Only requests that carry Meta's signature (made with your App Secret) are accepted, so nobody else can add fake leads. Until both secrets are set the endpoint refuses everything.
