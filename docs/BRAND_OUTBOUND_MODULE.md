# AI Email Outbound — How It Works

The system finds Shopify brands matching our ICP, writes personalised cold emails, sends them on a 4-touch sequence, and lets AI handle the replies. Built around three principles: only email brands that fit, make every opener feel human, stop the moment someone replies.

## The flow

**1. Find brands.** Storeleads pulls Shopify stores in our target verticals ($80k–$2M/mo, beauty / wellness / fashion / etc.). Apollo + Hunter find the right person and their email. Each brand gets an ICP score 0–10 — only score 7+ goes anywhere near our send pipeline.

**2. Write the email.** Claude looks at the brand's site, products, and creator signals, then writes a one-sentence observation that proves a human looked at them. The rest of the email is templated by group (G1 already-using-creators / G2 summer-seasonal / G3 cold) and touch (T1 → T4).

**3. Send a 4-touch sequence.** Each prospect gets four emails over 12 days: T+0 (hook), T+3 (different angle), T+7 (final ask), T+12 (breakup — "I'll stop here"). All four come from the same sender so the prospect sees one coherent thread.

**4. Reply triage.** When a prospect replies, the sequence stops automatically. If the campaign has auto-reply on, Claude writes the response in Federico's voice and sends from `brand@linkable.link`. Otherwise the team handles it.

**5. Daily warmup (right now).** Brand-new sending domains start in spam by default, so we spend 2 weeks sending casual conversational emails to friendly addresses to build reputation before any real cold goes out.

## Where things live

- **Cold sending** rotates across multiple inboxes (currently warming on `trylinkable.link`; graduates May 26). Each inbox has a daily cap.
- **Replies** all route to `brand@linkable.link` regardless of which inbox sent the original — keeps reply triage in one place.
- **Manual sends** from Zoho webmail still work; just don't count against the automated cap.

## Two things to know if you touch this

- Don't email a brand twice. The system tracks `contact_used` and refuses duplicates automatically.
- Don't add senders ad-hoc. New cold inboxes go through the sender pool (`sender_inboxes` table) so rotation + caps stay correct.

## Active campaigns

| Campaign | Auto-reply | Notes |
|----------|-----------|-------|
| UK Beauty 100k-500k | Yes — Federico Soressi voice | Currently the most active |
| US Beauty 1M-3.5M | No — team triages manually | Ingestion band needs widening to match |

## When something looks wrong

- **No emails going out** → pool needs a refresh (`run-storeleads.js`)
- **Wrong sender name** → check the AI persona for that campaign
- **Reply rate dropping** → check spam folder placement first, not the system
- **An inbox bouncing** → take it offline in `sender_inboxes`

For the full technical breakdown, see the code in `server/automation/`.
