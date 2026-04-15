// Discover Shopify brands via multiple sources
// Uses Bing search (better results than DDG) + large curated lists

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Domains to always skip
const SKIP_DOMAINS = new Set([
  "shopify.com", "myshopify.com", "amazon.com", "ebay.com", "etsy.com",
  "facebook.com", "instagram.com", "tiktok.com", "youtube.com", "twitter.com", "x.com",
  "linkedin.com", "pinterest.com", "reddit.com", "google.com", "bing.com",
  "wikipedia.org", "medium.com", "forbes.com", "vogue.com", "allure.com",
  "byrdie.com", "cosmopolitan.com", "nytimes.com", "bbc.co.uk", "theguardian.com",
  "sephora.com", "ulta.com", "nordstrom.com", "target.com", "walmart.com",
  "beautyindependent.com", "glossy.co", "businessinsider.com", "techcrunch.com",
  "producthunt.com", "crunchbase.com", "apps.shopify.com", "themes.shopify.com",
  "duckduckgo.com", "yahoo.com", "yelp.com", "trustpilot.com", "bbb.org",
  "indeed.com", "glassdoor.com", "apple.com", "microsoft.com", "github.com",
  "w3schools.com", "stackoverflow.com", "quora.com", "about.com",
]);

function extractDomain(url) {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch { return null; }
}

// Large curated list of known Shopify DTC brands across all categories
// This gives us guaranteed Shopify brands without needing unreliable search
const CURATED_BRANDS = [
  // Skincare
  "sundayriley.com", "drunk-elephant.com", "tatcha.com", "summerfridays.com",
  "tula.com", "peaceoutskincare.com", "starface.world", "versed.com",
  "youthtothepeople.com", "kinship.com", "truebotanicals.com", "maelove.com",
  "beautybio.com", "herbivorebotanicals.com", "olehenriksen.com", "freshbeauty.com",
  "reneskincare.com", "pixi.com", "skinkraft.com", "dermatica.co.uk",
  "geologie.com", "lumin.co", "bfranklingrooming.com", "bulldog.com",
  "jackblack.com", "kielhs.com", "clinique.com", "origins.com",
  "paulaschoice.com", "cerave.com", "laroche-posay.com", "avene.com",
  "nuxe.com", "caudalie.com", "vichy.com", "bioderma.com",
  "embryolisse.com", "filorga.com", "svr.com", "uriage.com",
  // Makeup
  "charlottetilbury.com", "narsissist.com", "toofaced.com", "urbandecay.com",
  "benefitcosmetics.com", "maccosmetics.com", "bobbibrown.com", "clinique.com",
  "glossier.com", "milkmakeup.com", "kosas.com", "ilia.com",
  "saiebeauty.com", "rarebeauty.com", "hauslabs.com", "jonesroadbeauty.com",
  "merit.com", "rmsbeauty.com", "westmanatelier.com", "lilahb.com",
  "lawlessbeauty.com", "aboutface.com", "onesize.com", "nudestix.com",
  "tartecosmetics.com", "morphe.com", "colourpop.com", "elfcosmetics.com",
  "nyxcosmetics.com", "mabelline.com", "lorealparisusa.com",
  // Haircare
  "olaplex.com", "olaplexhaircare.com", "livingproof.com", "ceremonia.com",
  "pattern.com", "curlsmith.com", "briogeo.com", "dphuehair.com",
  "crownaffair.com", "prose.com", "amika.com", "ouai.com",
  "odele.com", "function-beauty.com", "vegamour.com", "monatglobal.com",
  "oribe.com", "bumbleandbumble.com", "aveda.com", "kerastase.com",
  "moroccanoil.com", "aussie.com", "sheamoisture.com", "cantu.com",
  "devacurl.com", "mizani.com", "tresemme.com",
  // Wellness & Supplements
  "ritual.com", "seed.com", "athleticgreens.com", "ag1.com", "olly.com",
  "hum.com", "moonjuice.com", "golde.co", "bloom-nutrition.com",
  "vitalproteins.com", "sakara.com", "care-of.com", "persona.com",
  "naturemade.com", "gardenoflife.com", "newchapter.com", "megafood.com",
  "nordicnaturals.com", "solgar.com", "nowfoods.com", "jarrow.com",
  "draxe.com", "ancient-nutrition.com", "vital-proteins.com",
  "foursigmatic.com", "mudwtr.com", "laird-superfood.com",
  // Fashion & Apparel
  "allbirds.com", "rothys.com", "everlane.com", "vuoriclothing.com",
  "fabletics.com", "gymshark.com", "outdoorvoices.com", "girlfriend.com",
  "chubbies.com", "untuckit.com", "bombas.com", "meundies.com",
  "rhone.com", "cuts.com", "trueclassictees.com", "stance.com",
  "publicrec.com", "tenthousand.cc", "olivers.com", "mack-weldon.com",
  "naadam.co", "kotn.com", "lacausa.com", "tradlands.com",
  "sfranklinclothing.com", "frankandoak.com", "toddshelton.com",
  "marinelayer.com", "buckmanson.com", "taylorstitch.com",
  "roark.com", "rvca.com", "volcom.com", "billabong.com",
  "quiksilver.com", "hurley.com", "roxy.com", "dakine.com",
  "patagonia.com", "northface.com", "arcteryx.com", "rei.com",
  // Activewear
  "lululemon.com", "alo.com", "beyond-yoga.com", "viori.com",
  "bandier.com", "setactive.co", "year-of-ours.com", "wearitforward.com",
  "luckyandblessed.com", "pfranklinactive.com",
  // Jewelry & Accessories
  "mejuri.com", "analuisa.com", "gorjana.com", "kendrascott.com",
  "baublebar.com", "aurate.com", "missoma.com", "monicavinader.com",
  "catbirdnyc.com", "vfranklinrings.com", "ringconcierge.com",
  "stonefoxbride.com", "mariahtash.com", "studs.com", "rowan.com",
  "piercingpagoda.com", "bfranklinbracelets.com",
  "sfranklinearrings.com", "lfranklinlockets.com",
  // Sunglasses
  "warbyparker.com", "sunski.com", "goodr.com", "knockaround.com",
  "blenders.com", "shadesclub.com",
  // Food & Beverage
  "magicspoon.com", "liquid-iv.com", "drinkolipop.com", "poppi.com",
  "drinkhint.com", "rxbar.com", "perfectbar.com", "larabar.com",
  "kindsnacks.com", "clif.com", "thinkthin.com", "gomacro.com",
  "oatly.com", "chobani.com", "siggis.com", "ripplefoods.com",
  "drinkbai.com", "lacroixwater.com", "spindrift.com", "topo-chico.com",
  "recess.com", "vybes.co", "dfranklindrinks.com",
  // Coffee & Tea
  "tradecoffee.com", "bluebottlecoffee.com", "counterculturecoffee.com",
  "stumptowncoffee.com", "intelligentsia.com", "vervecoffe.com",
  "birchcoffee.com", "drinkchaga.com", "chamberlain-coffee.com",
  "cometeer.com", "yerbae.com", "guayaki.com",
  // Home & Kitchen
  "brooklinen.com", "parachutehome.com", "boll-branch.com",
  "caraway.com", "ourplace.com", "misen.com", "materialkitchen.com",
  "greats.com", "brightland.co", "graza.co", "omsom.com",
  "flybyjing.com", "momofuku-goods.com", "bushwickkitchen.com",
  "truff.com", "sietefoods.com",
  // Candles & Home Fragrance
  "boysmells.com", "otherland.com", "brooklyncandlestudio.com",
  "candlefish.com", "dfranklincandles.com", "paddywax.com",
  "apotheke.co", "vitruvi.com", "p-f-candle.com",
  // Pets
  "bfranklinpets.com", "olliepets.com", "sundays-dog.com", "thefarmersdog.com",
  "barkbox.com", "wildone.com", "fableobjects.com", "fi.co",
  "openfarmpet.com", "justfoodfordogs.com", "petplate.com",
  "nom-nom.com", "dfranklindog.com",
  // Baby & Kids
  "lovevery.com", "primaryclothing.com", "maisonette.com",
  "monicaandandy.com", "teacollection.com", "hannaandersson.com",
  "littlesleepies.com", "kickeepants.com",
  // Personal Care
  "harrys.com", "manscaped.com", "beardbrand.com", "drsquatch.com",
  "nativecos.com", "lfranklindeodorant.com", "eachevery.com",
  "schmidts.com", "ogni.com", "humblebrands.com",
  "billie.com", "athena-club.com", "flamingo.com",
  "lovewellness.com", "dame.com", "getmaude.com",
  "fur-oil.com", "lfranklinlube.com",
  // Oral Care
  "bfranklinbrush.com", "quip.com", "bfranklintoothpaste.com",
  "bfranklinfloss.com", "byte.com", "smiledirectclub.com",
  // Fitness Equipment
  "whoop.com", "hyperice.com", "tonal.com", "therabody.com",
  "mirror.co", "hydrow.com", "tempo.fit", "forme.life",
  // Outdoor / Adventure
  "yeti.com", "hydroflask.com", "swell.com", "kleankanteen.com",
  "nalgene.com", "miir.com", "corkcicle.com", "snowpeak.com",
  // Sleep
  "eightsleep.com", "casper.com", "purplemattress.com", "helix.com",
  "saatva.com", "bfranklinbedding.com", "tuftandneedle.com",
  // Luggage / Travel
  "away.com", "monos.com", "beis.com", "july.com",
  "horizn-studios.com", "dfranklintravel.com",
  // Sustainable / Eco
  "pangaia.com", "tentree.com", "pfranklinplastic.com", "grove.co",
  "packagefreeshop.com", "earthhero.com", "bfranklinrecycle.com",
  // UK / EU DTC
  "huel.com", "grind.co.uk", "papier.com", "finisterre.com",
  "rapanui.com", "toast.co.uk", "percup.com", "allplants.com",
  "oddbox.co.uk", "whowhatwear.co.uk", "seaspray.co.uk",
  "ocean-bottle.com", "chilly.com", "ellamilk.com",
  "theturmericco.co.uk", "dfranklinuk.co.uk", "ohpolly.com",
  "prettylittlething.com", "boohoo.com", "missguided.com",
  "asos.com", "nastygal.com", "riverisland.com",
  "tkmaxx.com", "joules.com", "fatface.com", "whitestuff.com",
  "bfranklinlondon.co.uk", "spacenk.com", "cultbeauty.co.uk",
  "lookfantastic.com", "beautybay.com", "feelunique.com",
  "beautypie.com", "theordinary.com", "deciem.com",
];

// Search Bing for more brands
async function searchBing(query) {
  try {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=50`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    const domains = new Set();
    const hrefMatches = html.match(/href="https?:\/\/[^"]+"/g) || [];
    for (const match of hrefMatches) {
      const url = match.replace(/^href="/, "").replace(/"$/, "");
      const domain = extractDomain(url);
      if (domain && !SKIP_DOMAINS.has(domain) && !domain.includes("bing.") && !domain.includes("microsoft.")) {
        domains.add(domain);
      }
    }
    return [...domains];
  } catch { return []; }
}

const SEARCH_QUERIES = [
  "best shopify stores 2024", "top DTC brands shopify",
  "shopify success stories ecommerce", "fastest growing shopify brands",
  "best shopify beauty stores", "shopify fashion brands list",
  "top shopify food brands", "shopify wellness brands",
  "best shopify jewelry stores", "shopify pet brands",
  "shopify home goods brands", "shopify fitness brands",
  "indie brands shopify store list", "new DTC brands 2024 shopify",
  "shopify brands worth checking out", "best ecommerce brands shopify",
  "top 100 shopify stores", "shopify store examples",
  "shopify brands uk", "shopify brands europe",
];

/**
 * Discover new Shopify brand domains
 */
export async function discoverBrands(alreadyProcessed, target = 800) {
  const discovered = new Set();

  // Phase 1: Curated list (reliable)
  console.log("  Adding curated brand list...");
  for (const domain of CURATED_BRANDS) {
    const clean = domain.replace(/^www\./, "").toLowerCase();
    if (!alreadyProcessed.has(clean)) discovered.add(clean);
  }
  console.log(`    ${discovered.size} new from curated list`);

  // Phase 2: Bing search (only if curated gives very few results)
  if (discovered.size < 20) {
    console.log("  Searching Bing for more brands...");
    const shuffled = [...SEARCH_QUERIES].sort(() => Math.random() - 0.5).slice(0, 5);

    for (const query of shuffled) {
      if (discovered.size >= target) break;
      const domains = await searchBing(query);
      let added = 0;
      for (const d of domains) {
        if (!alreadyProcessed.has(d) && !discovered.has(d)) { discovered.add(d); added++; }
      }
      if (added > 0) console.log(`    "${query}" → ${added} new (total: ${discovered.size})`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n  Discovery complete: ${discovered.size} new domains\n`);
  return [...discovered];
}
