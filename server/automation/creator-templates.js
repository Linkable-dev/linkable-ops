// Default 4-touch sequence templates for influencer outbound.
//
// Tier × touch matrix: 3 tiers (C1 Macro / C2 Mid / C3 Micro) × 4 touches.
// 12 templates total; each campaign starts with this set and can edit or
// regenerate per-slot via the AI draft endpoint.
//
// The pitch is "join Linkable so brands can find you based on your actual
// conversion performance — not vanity metrics." That's the default; operators
// who want a different angle (collab brief, re-activation) edit the bodies
// or use the AI draft generator with a custom brief.
//
// Placeholders:
//   {{firstName}}     — creator first name (safe-fallback "there")
//   {{handle}}        — instagram_username with @ prefix; falls back to firstName
//   {{niche}}         — creator niche; falls back to "your niche"
//   {{followersBand}} — humanised follower count (e.g. "12K", "1.2M")
//   {{observation}}   — AI-generated 15-30 word sentence (or niche fallback)
//
// Tone register varies by tier:
//   C1 Macro — formal, business-first, respect-time, big-picture ROI
//   C2 Mid   — warm + specific, frame as collab opportunity, low-friction
//   C3 Micro — community + hands-on, soft pitch, more about the creator

export const CREATOR_SEQUENCE_TEMPLATES = [
  // ----- C1 · Macro (200k+) -----
  {
    key: "C1-T1",
    group: "C1",
    touch: 1,
    name: "C1 · Macro · Performance-first intro",
    subject_template: "Linkable for {{handle}}",
    body_template: `Hi {{firstName}},

Brands on Linkable book creators based on actual sales conversion, not follower count. For someone at {{followersBand}} in {{niche}}, that usually means better deals and fewer lowball pitches.

{{observation}}

We're actively onboarding creators your brands already want to work with. 15 minutes if useful: https://linkable.link

Federico`,
  },
  {
    key: "C1-T2",
    group: "C1",
    touch: 2,
    name: "C1 · Macro · ROI math",
    subject_template: "{{handle}} — what you're leaving on the table",
    body_template: `Hi {{firstName}},

Quick follow-up. Brands tell us they overpay creators by 3-5x because they can't see actual conversion data — and underpay the few who do drive sales.

You're likely in the second group. Linkable surfaces that signal directly to brands so the rate they offer reflects what you actually deliver.

Worth a 15-min look: https://linkable.link

Federico`,
  },
  {
    key: "C1-T3",
    group: "C1",
    touch: 3,
    name: "C1 · Macro · Soft close",
    subject_template: "Last note — Linkable",
    body_template: `Hi {{firstName}},

Last note from me. We're capping the macro creator slots in {{niche}} at a small number to keep brand-side demand high per creator.

If you'd like to be in that group, takes 2 minutes: https://linkable.link

Otherwise, no problem at all — I'll stop here.

Federico`,
  },
  {
    key: "C1-T4",
    group: "C1",
    touch: 4,
    name: "C1 · Macro · Breakup",
    subject_template: "Closing this out",
    body_template: `Hi {{firstName}},

Closing the loop on this. I won't follow up again unless you reach out.

If anything changes — or a brand pitches you and you want to know if their offer matches your actual numbers — happy to plug you in fast.

https://linkable.link

Federico`,
  },

  // ----- C2 · Mid (10k–200k) -----
  {
    key: "C2-T1",
    group: "C2",
    touch: 1,
    name: "C2 · Mid · Collab opportunity intro",
    subject_template: "{{handle}} — brand collabs that actually pay",
    body_template: `Hi {{firstName}},

I run Linkable — brands use us to find creators in {{niche}} based on conversion performance instead of follower count. Mid-tier creators usually win here because engagement is higher and brands like the unit economics.

{{observation}}

Free to join, you set your own rates: https://linkable.link

Federico`,
  },
  {
    key: "C2-T2",
    group: "C2",
    touch: 2,
    name: "C2 · Mid · Low-friction value",
    subject_template: "How Linkable works (for creators)",
    body_template: `Hi {{firstName}},

Quick follow-up — Linkable is free for creators. You connect your Instagram, set the brand types you'll work with, and brands reach out with paid collabs. We handle the tracking and the payout.

Most creators at {{followersBand}} get their first paid brief within 2-3 weeks.

Sign up here: https://linkable.link

Federico`,
  },
  {
    key: "C2-T3",
    group: "C2",
    touch: 3,
    name: "C2 · Mid · Direct ask",
    subject_template: "Worth a try?",
    body_template: `Hi {{firstName}},

Last note. Joining takes ~2 minutes and costs nothing. If a brand match shows up, you decide whether to say yes.

If now's not the right time, just ignore this — I won't keep emailing.

https://linkable.link

Federico`,
  },
  {
    key: "C2-T4",
    group: "C2",
    touch: 4,
    name: "C2 · Mid · Breakup",
    subject_template: "Closing this out",
    body_template: `Hi {{firstName}},

I'll stop here. If brand-side demand picks up in {{niche}} and I think your profile is a fit, I might reach out down the line — but no follow-ups in the meantime.

The signup link if you ever want it: https://linkable.link

Federico`,
  },

  // ----- C3 · Micro (<10k) -----
  {
    key: "C3-T1",
    group: "C3",
    touch: 1,
    name: "C3 · Micro · Community pitch intro",
    subject_template: "{{handle}}, quick one",
    body_template: `Hi {{firstName}},

I'm Federico, building Linkable — a platform where brands find creators based on conversion performance instead of follower count. Micro creators in {{niche}} tend to outperform macro on the metrics that actually matter (engagement, conversion).

{{observation}}

Free to join, no minimums on followers: https://linkable.link

Federico`,
  },
  {
    key: "C3-T2",
    group: "C3",
    touch: 2,
    name: "C3 · Micro · How it works",
    subject_template: "How creators get paid on Linkable",
    body_template: `Hi {{firstName}},

Quick how-it-works: brands post briefs, you accept the ones you like, post the content, get paid based on the sales you drive. Tracking and payout handled by us.

A lot of micro creators in {{niche}} are pulling more from a few engaged followers than macros are from a million. Worth seeing where you'd land:

https://linkable.link

Federico`,
  },
  {
    key: "C3-T3",
    group: "C3",
    touch: 3,
    name: "C3 · Micro · Soft ask",
    subject_template: "Last one from me",
    body_template: `Hi {{firstName}},

Last note. Joining is free, takes 2 minutes, and you decide which briefs to accept.

If it's not for you, no worries — won't keep nudging.

https://linkable.link

Federico`,
  },
  {
    key: "C3-T4",
    group: "C3",
    touch: 4,
    name: "C3 · Micro · Breakup",
    subject_template: "Closing this out",
    body_template: `Hi {{firstName}},

Stopping here. If you ever want to take a look — same link, same 2 minutes:

https://linkable.link

Best,
Federico`,
  },
];

// Lookup by template_key (e.g. "C2-T1"). Returns the seed template object
// or null when the slot doesn't exist (defensive — the matrix is complete,
// but the orchestrator should never crash on a missing slot).
export function getCreatorSequenceTemplate(group, touch) {
  return CREATOR_SEQUENCE_TEMPLATES.find((t) => t.group === group && t.touch === touch) || null;
}
