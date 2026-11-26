import { test } from "node:test";
import assert from "node:assert/strict";
import { postDate, refusal, cleanGreeting, mendVariables } from "../lib/outreach-quality.js";

// Every case below is a real email from the first three days (23-26 Nov 2026).
const NOW = new Date("2026-11-26T12:00:00Z");
const brand = (to_email, variables = {}, step = 0) => ({ audience: "brand", to_email, step, variables: { greeting: "Hi,", ...variables } });
const creator = (to_email, variables = {}, step = 0) => ({ audience: "creator", to_email, step, variables: { greeting: "Hi Anna,", ...variables } });

test("an Instagram link carries the day the post went up", () => {
  assert.equal(postDate("https://www.instagram.com/p/CCURAevDRvh/").toISOString().slice(0, 10), "2020-07-06");
  assert.equal(postDate("https://www.instagram.com/p/DdmATDjgOI9/").toISOString().slice(0, 10), "2026-09-22");
  assert.equal(postDate("https://www.instagram.com/reel/DdmATDjgOI9/").toISOString().slice(0, 10), "2026-09-22");
  assert.equal(postDate(""), null);
  assert.equal(postDate("https://example.com/p/abc"), null);
});

test("customer-service inboxes and help desks are not written to; info@ and hello@ are", () => {
  for (const a of ["support@nutra-harmony.com", "writetous@himalayausa.com", "customer.services@smallsmart.co.uk",
    "service.uk@fashlets.com", "help@oliviaumma.com", "support_uk@edurino.com", "enquiries@regentiv.co.uk", "support@missha.zendesk.com"]) {
    assert.equal(refusal(brand(a), NOW), "customer-service inbox", a);
  }
  for (const a of ["info@zenottic.com", "hello@cleolifestyle.com", "lucy@happylinencompany.co.uk", "cultivate@gmail.com"]) {
    assert.equal(refusal(brand(a), NOW), null, a);
  }
});

test("placeholder addresses and countries we do not write to are refused", () => {
  assert.equal(refusal(brand("ihre@email.com"), NOW), "placeholder address");
  assert.equal(refusal(brand("your@domain.com"), NOW), "placeholder address");
  assert.match(refusal(brand("info@manposh.pk"), NOW), /\.pk/);
  assert.match(refusal(creator("katie.ma@eelin.com.tw"), NOW), /\.tw/);
  assert.equal(refusal(brand("info@lumoraofficial.co.uk"), NOW), null);
  assert.equal(refusal(creator("shelly@eclectix.co"), NOW), null);
});

test("a creator call too old to mention stops the brand, at any step", () => {
  const old = "https://www.instagram.com/p/CCURAevDRvh/";
  const v = { intentPostUrl: old, proofBlock: `Saw you were after creators.\n${old}` };
  assert.match(refusal(brand("claire@teneragrains.com", v), NOW), /creator call is \d+ days old/);
  assert.match(refusal(brand("claire@teneragrains.com", v, 1), NOW), /creator call/);
  // The call link is carried but not used: the email is about a creator's post.
  assert.equal(refusal(brand("info@x.com", { intentPostUrl: old, proofBlock: "@anna posted about you" }), NOW), null);
});

test("agencies are not the creator, and an old post only matters for the first email", () => {
  for (const a of ["info@sintillatetalent.com", "bethmccreadie@thebloggeragent.co.uk", "jerrim@stride-social.com", "caroline@sparkleagency.us", "info@thirteenmanagement.co.uk"]) {
    assert.equal(refusal(creator(a), NOW), "an agency, not the creator", a);
  }
  const old = { examplePost: "https://www.instagram.com/p/Dan2zy6iFNh/" }; // July 2026
  assert.match(refusal(creator("anna@gmail.com", old), NOW), /post is \d+ days old/);
  assert.equal(refusal(creator("anna@gmail.com", old, 1), NOW), null);
});

test("greetings: wrong or unbelievable names become a bare hello, shouting names are tidied", () => {
  const g = (row) => cleanGreeting(row);
  assert.equal(g(brand("claire@teneragrains.com", { greeting: "Hi Rebecca," })), "Hi,");
  assert.equal(g(brand("hello@well-actually.co.uk", { greeting: "Hi Customer," })), "Hi,");
  assert.equal(g(brand("jo@shop.com", { greeting: "Hi Jo," })), "Hi Jo,");
  assert.equal(g(brand("hello@shop.com", { greeting: "Hi Elaine," })), "Hi Elaine,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi Dr.," })), "Hi,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi Yasmine|," })), "Hi Yasmine,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi MARIYA," })), "Hi Mariya,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi ioana," })), "Hi Ioana,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi LO," })), "Hi,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi 2.fit.bros," })), "Hi,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi 2Kaysisters," })), "Hi,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi skincarewithshelbs," })), "Hi,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Hi @anna.makes," })), "Hi @anna.makes,");
  assert.equal(g(creator("a@gmail.com", { greeting: "Ciao Anna," })), "Ciao Anna,");
  assert.equal(g(brand("giulia@negozio.it", { greeting: "Ciao Rebecca,", language: "it" })), "Buongiorno,");
  assert.equal(g(brand("info@x.com", { greeting: "Hi," })), "Hi,");
});

test("the single-creator sentence is mended in the first email and the follow-up", () => {
  const v = mendVariables(brand("info@zenottic.com", {
    proofBlock: "ZENOTTIC Eyewear runs GoAffPro, so you're already paying creators on results.\n\nWhich is why @gqueralezf caught my eye.\nhttps://www.instagram.com/p/DeiiR5Hg6vq/\n\none creator posted about ZENOTTIC Eyewear in the last 90 days. GoAffPro pays whoever signs themselves up, and I'd guess most of that lot never did.",
    followUpHook: "One question. Of the one creator who posted about ZENOTTIC Eyewear this quarter, how many ended up in GoAffPro?",
  }));
  assert.ok(!/one creator posted|that lot/.test(v.proofBlock), v.proofBlock);
  assert.ok(v.proofBlock.endsWith("\n\nGoAffPro pays whoever signs themselves up, and creators who post without being asked rarely do."));
  assert.equal(v.followUpHook, "One question. When @gqueralezf posted about ZENOTTIC Eyewear, did they end up in GoAffPro?");
  const many = mendVariables(brand("info@x.com", { proofBlock: "intro\n\n11 creators posted about X in the last 90 days." }));
  assert.equal(many.proofBlock, "intro\n\n11 creators posted about X in the last 90 days.");
  const several = mendVariables(brand("info@x.com", { proofBlock: "intro\n\nseveral creators posted about X." }));
  assert.equal(several.proofBlock, "intro\n\nSeveral creators posted about X.");
});
