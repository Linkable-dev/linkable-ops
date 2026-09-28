# Instagram replies in the DM queue

The Instagram tab (`/gtm/brands/instagram`) works without any of this: messages
are drafted, copied into Instagram by hand and marked sent with a button. This
connects the Instagram account the DMs are sent from to Meta, so that:

- a brand's reply lands on the lead by itself (Sent tab: the reply text, and
  the lead is marked *replied*);
- a DM sent from the Instagram app marks the lead *sent* without anyone
  pressing "Mark sent", and a later message to the same brand counts as its
  follow-up;
- a brand that replied can be answered from the page ("Send on Instagram"),
  inside the 24 hours Instagram allows after their last message.

Instagram's API never allows the **first** message to a brand that has not
written to us. That part stays by hand, whatever is configured here.

## What it needs

1. The sending account must be an Instagram **professional** account
   (Business or Creator).
2. A Meta app (developers.facebook.com → My Apps → Create app → type
   *Business*) with the **Instagram** product, set up for
   *Instagram API with Instagram Login*.
3. The sending account added to the app (App roles → Instagram testers, then
   accept the invite in the Instagram app: Settings → Website permissions →
   Apps and websites → Tester invites). With the account in a role on the
   app, *standard access* is enough and no app review is needed.
4. Permissions: `instagram_business_basic`,
   `instagram_business_manage_messages`.
5. In the app's Instagram settings, generate an access token for the account
   (long-lived, 60 days; refresh it before it expires).
6. Webhooks → Instagram → callback URL
   `https://<ops domain>/api/instagram/webhook`, verify token = the value of
   `META_VERIFY_TOKEN` below, and subscribe to the **messages** field.

## Environment variables (Vercel, ops project)

| Variable | What |
|---|---|
| `META_APP_SECRET` | App settings → Basic → App secret. |
| `IG_APP_SECRET` | The *Instagram app secret* on the Instagram API setup page. Every webhook POST must be signed with one of these two secrets (Meta does not say plainly which it uses); with neither set, every POST is refused and the refusal is logged as `[instagram-webhook] signature refused`. |
| `META_VERIFY_TOKEN` | Any long random string; the same one typed into the webhook setup. |
| `IG_ACCESS_TOKEN` | The account's access token from step 5. Used to look up who wrote and to send answers. |
| `IG_GRAPH_VERSION` | Optional, default `v21.0`. |

With `IG_ACCESS_TOKEN` unset the page hides "Send on Instagram"; with the
webhook not subscribed nothing arrives. Both fail quietly and the queue keeps
working by hand.

## Where things go

- Every message, both directions: `prospector_dm_messages` (ops Supabase),
  keyed on Meta's message id so a redelivery is a no-op.
- The lead: `ig_user_id` (the brand's Instagram-scoped id, set the first time
  it is seen), `dm_state` / `dm_replied_at` / `dm_reply_text`,
  `dm_sent_at` + `dm_sent_by = 'instagram'` for sends seen through echoes.
- Code: `server/routes/instagram-webhook.js`, `server/lib/instagram-graph.js`.
