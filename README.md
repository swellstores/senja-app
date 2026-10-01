# Senja for Swell

Show your [Senja](https://senja.io) testimonials on your Swell store and collect new ones automatically. The app copies your Senja testimonials into Swell and links them to products, so every product gets a testimonial count and an average rating. It can also email customers a link to your Senja form a few days after their order is delivered. Add a Senja widget ID to any product to show that widget on its page.

- **Works on every Senja plan:** showing widgets on product pages.
- **Needs Senja Starter or higher:** copying testimonials into Swell, product ratings, and review invites. These use the Senja API, which isn't on the Free plan.

## Features

### Widgets on product pages
Choose which Senja widget each product shows.

- **In the dashboard:** Products → a product → **Senja** tab → **Senja widget ID**. Leave it empty to show your store's default widget.
- **On the storefront:** your theme reads the product's widget ID and embeds the widget (see [Show widgets on your storefront](#show-widgets-on-your-storefront)).
- **Implemented by:** the `widget_id` field on products (`models/products.json`, `content/products.json`). It's readable through the storefront API.

### Testimonials copied into Swell
Your Senja testimonials appear in Swell and stay up to date.

- **In the dashboard:** Products → **Testimonials**, with Approved and Not approved tabs. Records are read-only. Approve, edit or delete testimonials in Senja, and the change appears in Swell.
- **Timing:**
  - Every 10 minutes the app checks Senja for new testimonials. New ones appear within about 10 minutes.
  - Once a day it runs a full sync. That picks up edits to older testimonials and removes testimonials you deleted in Senja.
  - The first full sync starts within 10 minutes of adding your API key.
- **Sync status:** Apps → Senja → Settings → **Sync status** shows when the app last checked Senja and the result (for example "Up to date", or an error to fix). It updates every 10 minutes.
- **Sync history:** Reporting → **Testimonial syncs** shows each full sync: when it ran, how many testimonials were added, updated or removed, and any error.
- **On the storefront:** approved testimonials are readable through the storefront API at `/apps/senja/testimonials`. Unapproved testimonials and customer emails are never public.
- **Implemented by:** `functions/sync-testimonials.ts` (cron, every 10 minutes), `functions/lib/senja.ts` (Senja API client), `functions/lib/testimonials.ts`, and the `testimonials` and `syncs` collections.

### Testimonials linked to products
Tag a testimonial in Senja with a product's **slug** or **SKU** (for example `blue-sneaker`), and the app links it to that product.

- **In the dashboard:** the product's **Senja** tab lists its testimonials.
- **Implemented by:** `syncTestimonialBatch` in `functions/lib/testimonials.ts`. If several tags match, the first matching product wins.

### Product ratings
Each product shows how many approved testimonials it has and their average rating (to one decimal). Unrated testimonials count toward the total but not the average.

- **In the dashboard:** the product's **Senja** tab.
- **On the storefront:** `testimonial_count` and `rating_average` on the product, under `$app.senja` (see below).
- **Implemented by:** `functions/update-product-stats.ts`, which runs whenever a testimonial is added, changed or removed.

### Review invites after delivery
A set number of days after an order is fully delivered, Senja emails the customer a link to your Senja form.

- **In the dashboard:** Orders → **Review invites**, with Scheduled, Sent, and Skipped or failed tabs. Each invite shows the customer, the order, the send date and, if it wasn't sent, why.
- **Each order gets at most one invite.**
- **Implemented by:**
  - `functions/schedule-invite.ts` runs on `order.delivered` and creates the invite.
  - `functions/send-invite.ts` runs on the invite's send date and calls Senja's `POST /invites`.
  - The `invites` collection stores the records.
- **Outcomes:**

  | Status | Meaning |
  |---|---|
  | Sent | Senja emailed the customer. |
  | Skipped | Senja declined (for example, the person was already invited), or invites were turned off before the send date. |
  | Failed | The API key or form ID is missing or wrong. The details say what to fix. |

  If Senja is down or rate-limiting, the invite is retried automatically.

## Setup

1. **Install the app** from the Swell App Store.
2. **Connect Senja** (Starter plan or higher): in Senja, open **Automate** and copy your **API key**. In Swell, open **Apps → Senja → Settings → Senja connection**, paste it into **API key**, and click **Save settings**. Your testimonials start copying within 10 minutes. Check progress under Reporting → Testimonial syncs.
3. **Link testimonials to products (optional):** in Senja, tag each testimonial with the product's slug or SKU.
4. **Turn on review invites (optional):** under **Review invites**, switch on **Send review invites**, enter your **Senja form ID** (open the form in Senja and copy the ID from its URL), and set **Days after delivery**.
5. **Show widgets** on your storefront: see below.

### Settings

| Panel | Setting | What it does |
|---|---|---|
| Senja connection | API key | Your Senja API key. Needed for copying testimonials, product ratings and review invites. |
| Review invites | Send review invites | Turns automatic invites on or off. Off by default. |
| Review invites | Senja form ID | The Senja form customers are invited to fill in. |
| Review invites | Days after delivery | How long to wait after an order is fully delivered (0–90, default 7). |
| Sync status | Last checked, Status | Read-only. Updated by the app after every sync run. |
| Review invites | Only invite customers who accept marketing emails | Some regions, such as the EU, treat review requests as marketing. When on, only customers who opted in to marketing emails are invited. Off by default. |

Per product: **Senja widget ID** on the product's Senja tab.

## Show widgets on your storefront

Swell apps can't add blocks or scripts to storefronts yet, so the widget goes in your theme or headless frontend once. Your developer can add it like this:

1. **Get the widget ID:** in Senja, open the widget, choose **Share / Embed**, and copy the ID from `data-id="…"`. Use one as your store's default.
2. **Read the product's widget ID** from the storefront API. It's at `product.$app.senja.widget_id`. Fall back to your default when it's empty:

   ```js
   const product = await swell.products.get('blue-sneaker');
   const widgetId = product.$app?.senja?.widget_id || 'YOUR-DEFAULT-WIDGET-ID';
   ```

3. **Embed it** where the testimonials should appear:

   ```html
   <div class="senja-embed" data-id="WIDGET_ID" data-mode="shadow" data-lazyload="false"></div>
   <script async type="text/javascript" src="https://static.senja.io/dist/platform.js"></script>
   ```

To show ratings without a widget, use `product.$app.senja.testimonial_count` and `product.$app.senja.rating_average`. The approved testimonials themselves are at `/api/apps/senja/testimonials` (filter by `product_id`).

## Day-to-day use

- **Manage testimonials in Senja.** Approving, editing, tagging and deleting all happen there, and Swell follows. New testimonials appear within about 10 minutes; changes to older ones and deletions within a day.
- **Check Orders → Review invites** now and then. The "Skipped or failed" tab shows invites that didn't go out, and why.
- **If testimonials stop updating**, check **Sync status** on the app's Settings page first, then Reporting → Testimonial syncs for details. A failed sync shows the error, usually an expired API key or a Senja plan that no longer includes the API. After you fix the key, the next sync starts within an hour.

## Limits and known issues

- **No instant updates.** Swell apps can't yet receive calls from outside services without a Swell key, so the app checks Senja on a schedule instead of using Senja's webhooks. New testimonials take up to about 10 minutes, edits to older ones and deletions up to a day.
- **Widgets need a one-time theme change.** Swell apps can't add storefront blocks or scripts yet, except for payment methods.
- **Testimonial records can look editable.** The dashboard's empty state still offers a "Create" button, which Swell apps can't hide. Testimonials, invites and syncs are managed by the app; anything created by hand isn't synced to Senja.
- **Senja plans:** API features need Starter or higher. Widgets work on every plan.
- **Rate limits:** the full sync reads 25 testimonials per page and pauses between runs to stay within Swell's 10-second function limit. Very large accounts (thousands of testimonials) take several runs to finish the first sync.
- **Guest checkouts:** invites use the email on the customer's account, which guest checkouts have too. Orders without an email are skipped.
- **Environments:** works in both test and live. Each environment has its own settings, so add the API key in each one you use.

## Development

Requirements: Node 20+, the Swell CLI (`npm install -g @swell/cli`), and access to the **swell-apps** store.

```bash
npm install
npm run typecheck
npm test
```

- **Tests:** unit tests live in `test/unit/` (vitest, Cloudflare Workers pool). They mock Swell and the Senja API, so they need no credentials.
- **Deploy to the test environment:** `swell switch swell-apps`, then `swell app push`. After every push, run `swell inspect functions --app=.` and `swell inspect content --app=.` to confirm everything registered.
- **Try a route or collection:** `swell api get /apps/senja/testimonials`, `swell api get /apps/senja/syncs`.

**Project layout:**

| Path | Contents |
|---|---|
| `models/` | `testimonials`, `invites`, `syncs` collections; `products.json` adds `widget_id`, `testimonial_count`, `rating_average` |
| `content/` | Dashboard screens |
| `settings/` | `connection` (API key), `invites`, and `status` (read-only, written by the sync) panels |
| `functions/` | `sync-testimonials` (cron), `schedule-invite` (`order.delivered`), `send-invite` (scheduled on the invite's send date), `update-product-stats` (testimonial changes) |
| `functions/lib/` | Senja API client and shared helpers |
| `assets/` | `icon.png`; gallery images in `assets/images/`, listed in `swell.json` |

**Notes for the next developer:**

- **Dashboard field types:** content fields of type `float` fail to push with only "Something went wrong". Use `number` with `digits`.
- **Delete events:** delete events deliver the record's fields in `$event.data`, not on `req.data`. `update-product-stats` reads both.
- **Public routes:** routes with `public: true` still require the store's secret key, which is why there's no webhook receiver. If Swell adds truly public routes, a Senja webhook (`x-senja-signature`, HMAC-SHA256 hex of the JSON body) would make updates instant.
- **CLI validation:** `swell schema <type> <file>` currently fails on every file, so validate against `swell schema <type> --format=json-schema-bundle` with ajv instead.
