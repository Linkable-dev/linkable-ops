# Sender Pool Setup (Multi-Domain Resend)

One-time runbook for moving brand outbound off `brand@linkable.link` and onto a rotated pool of lookalike-domain inboxes. Migration `012_sender_pool.sql` creates `sender_inboxes`; `server/automation/sender-pool.js` consumes it. Until rows are inserted, the system stays on the legacy single-sender path (no behaviour change).

---

## Why

Sending cold from `linkable.link` mixes outbound prospecting with transactional product email (trial signups, demo confirmations, payout receipts). One bad campaign and the same domain that confirms a customer's trial lands in spam. Splitting cold onto separate domains protects `linkable.link` reputation.

Target steady state: ~6 inboxes across 3 lookalike domains, each capped at 40 sends/day = ~240 sends/day capacity. Scale by adding inboxes, never by raising per-inbox caps.

---

## Step 1 — Buy 3 lookalike domains (~$30/yr total)

Pick names that read as Linkable variants without being typo-squatters. Good candidates:

- `trylinkable.com`
- `linkable-app.com`
- `getlinkable.co`

Avoid: hyphens that look like typos, country-code TLDs that signal cheap operation (`.xyz`, `.click`), or domains too long to fit in a sender's "from" field. Buy through whatever registrar you already use (Namecheap, Cloudflare Registrar, Porkbun). Set WHOIS privacy ON.

**Do not use a subdomain of `linkable.link`** (e.g. `mail.linkable.link`). DKIM/DMARC reputation is shared at the registered-domain level, so a subdomain offers zero protection.

---

## Step 2 — Add each domain to Resend

For each domain in the Resend dashboard:

1. Domains → Add domain → enter `trylinkable.com`
2. Resend will show 4 DNS records to add at the registrar:
   - **SPF**: `TXT @ "v=spf1 include:amazonses.com ~all"`
   - **DKIM**: 3 CNAME records pointing to Resend-managed selectors
   - **DMARC**: `TXT _dmarc "v=DMARC1; p=none; rua=mailto:dmarc@<domain>"` — start with `p=none` to monitor, move to `p=quarantine` after 4 weeks of clean reports
3. Wait for DNS propagation (5 min – 24 hr depending on registrar) and verify in Resend
4. Repeat for the other 2 domains

---

## Step 3 — Create real mailboxes for replies

Resend sends, but it doesn't receive. Each inbox in the pool needs a real mailbox somewhere that can answer replies. Cheapest path: **Google Workspace** at $7/user/month, or **Zoho Mail** free tier (5 users on one domain).

For each persona (e.g. `federico@trylinkable.com`):

1. Add the domain to Google Workspace as a secondary domain
2. Create the user with that email
3. Configure MX records at the registrar (Workspace will show the values)
4. Test by sending yourself a message — confirm it lands

You can route replies to your existing inbox via forwarding rules. Read every reply yourself for the first 4 weeks — the early signal (positive vs negative, what people object to) is the most valuable data you'll get.

---

## Step 4 — Seed `sender_inboxes`

After migration 012 is applied, insert one row per inbox. Example for 6 inboxes across 3 domains, with Federico + Luca personas:

```sql
INSERT INTO sender_inboxes (team_id, email, from_name, reply_to, domain, daily_cap, warming_cap, is_warming) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'federico@trylinkable.com',  'Federico from Linkable', 'federico@trylinkable.com',  'trylinkable.com',  40, 10, true),
  ('a0000000-0000-0000-0000-000000000001', 'luca@trylinkable.com',      'Luca from Linkable',     'luca@trylinkable.com',      'trylinkable.com',  40, 10, true),
  ('a0000000-0000-0000-0000-000000000001', 'federico@linkable-app.com', 'Federico from Linkable', 'federico@linkable-app.com', 'linkable-app.com', 40, 10, true),
  ('a0000000-0000-0000-0000-000000000001', 'luca@linkable-app.com',     'Luca from Linkable',     'luca@linkable-app.com',     'linkable-app.com', 40, 10, true),
  ('a0000000-0000-0000-0000-000000000001', 'federico@getlinkable.co',   'Federico from Linkable', 'federico@getlinkable.co',   'getlinkable.co',   40, 10, true),
  ('a0000000-0000-0000-0000-000000000001', 'luca@getlinkable.co',       'Luca from Linkable',     'luca@getlinkable.co',       'getlinkable.co',   40, 10, true);
```

`is_warming=true` means each inbox uses `warming_cap` (10/day) until you flip it. Total capacity during warmup: 60 sends/day across the pool.

---

## Step 5 — Warm up (2–3 weeks, manual)

New domains land in spam by default. The pool needs to look like a real sender before serious cold volume.

For ~2 weeks before any real cold sends:

- **Send 5–10 real-feeling emails per inbox per day** to friendly addresses (your own other inboxes, co-founders, friends, family). Ask them to reply with one sentence so the conversation shows two-way traffic.
- **Vary the content** — boilerplate "warmup" emails get pattern-matched by spam filters. Write actual conversational prose.
- **Star/move to inbox** if any test mail lands in spam — Gmail learns from manual recovery.
- **Don't send to cold prospects** during the warming window. The pool's `is_warming=true` flag enforces a 10/day cap which keeps you honest.

After 2 weeks of clean delivery + replies, flip the flag for one inbox at a time:

```sql
UPDATE sender_inboxes SET is_warming = false WHERE email = 'federico@trylinkable.com';
```

Watch deliverability for 48 hours before graduating the next inbox. Once all 6 are graduated, you're at 240 sends/day capacity.

---

## Step 6 — Verify rotation is working

After the first day with the pool live, check distribution:

```sql
SELECT
  sender_email,
  COUNT(*) AS sends,
  COUNT(*) FILTER (WHERE replied_at IS NOT NULL) AS replied
FROM email_sends
WHERE sent_at >= now() - interval '24 hours'
  AND sender_email IS NOT NULL
GROUP BY sender_email
ORDER BY sends DESC;
```

You should see roughly even counts across active (non-warming) inboxes. If one is missing, it's probably failing the cap query — check that `is_active=true` for the missing row.

Alternatively, from a Node REPL:

```js
import { getInboxUsage } from "./server/automation/sender-pool.js";
console.log(await getInboxUsage("a0000000-0000-0000-0000-000000000001"));
```

---

## Ongoing hygiene

- **Monitor DMARC reports** weekly at the `rua=` address. Failures here are a 4-week-out warning of inbox placement problems.
- **Watch bounce rate per inbox.** Anything above 5% bounce → take that inbox offline (`UPDATE sender_inboxes SET is_active=false WHERE email='...'`) and investigate before re-enabling.
- **Rotate suppressions globally.** A bounce on `federico@trylinkable.com` should suppress the address for the whole pool — `ai_suppressions` already does this team-wide, no change needed.
- **Replace inboxes after 6–12 months if reputation degrades.** Cheap to spin up a new persona on the same domain.

---

## Rollback

To revert to the legacy single-sender behaviour without removing data:

```sql
UPDATE sender_inboxes SET is_active = false WHERE team_id = '...';
```

`getNextInbox` returns `hasPool: false` when no rows are active, and `sendDueRow` falls back to `campaign.sender_from` automatically.
