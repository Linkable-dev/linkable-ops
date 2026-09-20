import { useTheme } from "../contexts/ThemeContext";
import { Card } from "../components/ui/Card";
import { GtmTabs } from "../components/gtm/GtmTabs";

/**
 * Creator GTM.
 *
 * The brand side of GTM has three working parts: find, write, read the replies.
 * The creator side has none of them yet — every email_campaigns row in the
 * database is audience_type 'brand', and creator acquisition currently happens
 * inside the product rather than here.
 *
 * This page exists so the shape is visible and the gap is explicit. It says
 * what is missing rather than rendering an empty table that reads as "no
 * creators", which is a different and much more alarming claim.
 */
export default function CreatorsGtmPage() {
  const { theme } = useTheme();

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Creators</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 680 }}>
          Campaigns to find creators and get them onto Linkable. The mirror of Brands.
        </p>
      </div>

      <GtmTabs tabs={[{ to: "/gtm/creators", label: "Find" }]} />

      <Card>
        <div style={{ padding: 20, color: theme.textMuted, fontSize: 13, lineHeight: 1.7, maxWidth: 720 }}>
          <strong style={{ color: theme.text }}>Nothing here yet, and that is accurate.</strong>
          <p style={{ marginTop: 10 }}>
            Every outbound campaign in the database targets brands. Creator acquisition
            happens today inside the product — Autopilot sources creators for a brand's
            campaign — rather than as GTM for Linkable itself.
          </p>
          <p>
            What would live here: campaigns with a goal and a budget that find creators in
            a niche, check they are worth approaching, and invite them. The same engine the
            Brands side uses, pointed at the other half of the marketplace.
          </p>
          <p style={{ marginBottom: 0 }}>
            Until that exists, creator sourcing is under{" "}
            <span style={{ color: theme.text }}>Product → Autopilot</span>.
          </p>
        </div>
      </Card>
    </div>
  );
}
