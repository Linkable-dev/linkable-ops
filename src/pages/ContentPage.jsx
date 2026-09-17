import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * Campaign content, both kinds.
 *
 * Delivered is what a real creator sent back; Generated is what the machine
 * made. Two tabs rather than two pages because the question is usually "what
 * has this campaign got", and the answer is some of each.
 *
 * A brand has seen its own delivered library for months at
 * /brands/dashboard/content, and its generated one in the studio. Nobody could
 * see across them — whether creators are delivering at all, whether generation
 * is working or quietly failing, what any of it looks like — which is exactly
 * the kind of question this panel exists to answer.
 *
 * A grid rather than a table: the file IS the row. Everything else about it
 * (whose campaign, which creator, when, what state) fits under the thumbnail,
 * and a table of file names would make you open every one to find out what it
 * is.
 */

const PER_PAGE = 24;

const TABS = [
  ["delivered", "Delivered"],
  ["generated", "Generated"],
];

const TYPES = [
  ["", "All", "total"],
  ["image", "Images", "images"],
  ["video", "Video", "videos"],
];

const AGES = [
  [0, "All time"],
  [7, "Last 7 days"],
  [30, "Last 30 days"],
  [90, "Last 90 days"],
];

function size(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// A quiet label for one fact about an asset. Colour carries the weight, so
// the text can stay lower case and short.
function tag(theme, color) {
  return {
    fontSize: 11, fontWeight: 600, color,
    border: `1px solid ${theme.border}`, borderRadius: 999, padding: "1px 7px",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
  };
}

// Who the content is of. On the generated side that is one of four things,
// and "product" is the honest answer of "nobody" — product-only creatives
// depict no person, which is also why they never wait for an approval.
function creatorName(f) {
  if (f.creator_source === "product") return "product only";
  if (f.creator_label) {
    return f.creator_source === "avatar" ? `${f.creator_label} (AI)` : `@${f.creator_label}`;
  }
  if (f.instagram_username) return `@${f.instagram_username}`;
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  // Generated against a likeness whose creator record is not in this database
  // — true of every 'influencer' asset on dev. Saying so beats "a creator",
  // which reads as a name we simply did not bother to fetch.
  return f.creator_source ? "creator not on this database" : "a creator";
}

export default function ContentPage() {
  const { theme } = useTheme();

  const [data, setData] = useState(null);
  const [filters, setFilters] = useState({ brands: [], campaigns: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState("delivered");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [days, setDays] = useState(0);
  const [brand, setBrand] = useState("");
  const [product, setProduct] = useState("");
  const [offset, setOffset] = useState(0);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const d = tab === "generated"
        ? await api.getGeneratedContent({ q, days, brand, product, limit: PER_PAGE, offset })
        : await api.getContent({ q, type, days, brand, product, limit: PER_PAGE, offset });
      // Paging appends rather than replaces: this is a library you scroll, and
      // a grid that jumps back to the top on "more" has lost your place.
      setData((prev) =>
        offset > 0 && prev ? { ...d, files: [...prev.files, ...d.files] } : d,
      );
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tab, q, type, days, brand, product, offset]);

  useEffect(() => {
    const t = setTimeout(fetchPage, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [fetchPage, q]);

  useEffect(() => {
    api.getContentFilters().then(setFilters).catch(() => {});
  }, []);

  // Any change of filter starts the list again from the top.
  const narrow = (set) => (value) => {
    set(value);
    setOffset(0);
  };

  const field = {
    height: 32, padding: "0 10px", borderRadius: 8, border: `1px solid ${theme.border}`,
    background: theme.surface, color: theme.text, fontSize: 13, fontFamily: "inherit",
  };
  const muted = { color: theme.textMuted, fontSize: 12 };

  const files = data?.files || [];
  const totals = data?.totals || {};
  const more = files.length < (data?.matched || 0);

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Campaign content</h1>
      <p style={{ color: theme.textMuted, fontSize: 13, margin: "0 0 14px", maxWidth: 760 }}>
        {tab === "delivered" ? (
          <>
            Every file a real creator has delivered, across every brand — the same library each
            brand sees of its own, from the outside.
            {totals.total != null && (
              <>
                {" "}{totals.total} file{totals.total === 1 ? "" : "s"} from {totals.creators}{" "}
                creator{totals.creators === 1 ? "" : "s"}, for {totals.brands} brand
                {totals.brands === 1 ? "" : "s"}.
              </>
            )}
          </>
        ) : (
          <>
            Everything the machine has generated for a campaign, and how the generating itself is
            going — a grid of pictures cannot say "one request in fourteen failed".
          </>
        )}
      </p>

      <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
        {TABS.map(([key, label]) => {
          const on = tab === key;
          return (
            <button
              key={key}
              onClick={() => { setTab(key); setOffset(0); setData(null); }}
              style={{
                padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                fontFamily: "inherit", fontSize: 13, fontWeight: on ? 600 : 500,
                background: on ? theme.accentLight : "transparent",
                color: on ? theme.text : theme.textMuted,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* How generation is going, over everything — the half a grid cannot
          show. Only on the tab it describes. */}
      {tab === "generated" && data && data.available !== false && (
        <Card>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
            {[
              ["Requests", totals.requests],
              ["Assets", totals.assets],
              ["Partial", totals.partial],
              ["Failed", totals.failed],
              ["Still running", totals.in_flight],
              ["Spent", totals.cost_cents != null ? `$${(totals.cost_cents / 100).toFixed(2)}` : "—"],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
                  {label}
                </div>
                <div style={{
                  fontSize: 15, fontWeight: 700,
                  color: (label === "Failed" && value > 0) ? "#B91C1C"
                    : (label === "Partial" && value > 0) ? "#B45309" : theme.text,
                }}>
                  {value ?? "—"}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tab === "generated" && data?.available === false && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Not on this database</div>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            The content service has never run its migrations here, so there is nothing generated to
            show. Switch the database target to dev, where it runs.
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      <Card>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            style={{ ...field, flex: "1 1 260px", minWidth: 200 }}
            placeholder="Search a file, campaign, brand or creator…"
            value={q}
            onChange={(e) => narrow(setQ)(e.target.value)}
          />
          <div style={{ display: "flex", gap: 4 }} hidden={tab === "generated"}>
            {TYPES.map(([value, label, countKey]) => {
              const on = type === value;
              return (
                <button
                  key={value || "all"}
                  onClick={() => narrow(setType)(value)}
                  style={{
                    padding: "5px 12px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 12, fontWeight: on ? 600 : 400,
                    border: `1px solid ${on ? theme.text : theme.border}`,
                    background: on ? theme.accentLight : "transparent",
                    color: on ? theme.text : theme.textMid,
                  }}
                >
                  {label}
                  {totals[countKey] != null && (
                    <span style={{ color: theme.textMuted }}> {totals[countKey]}</span>
                  )}
                </button>
              );
            })}
          </div>
          <select style={field} value={brand} onChange={(e) => narrow(setBrand)(e.target.value)}>
            <option value="">Every brand</option>
            {filters.brands.map((b) => (
              <option key={b.id} value={b.id}>{b.label.trim()} ({b.files})</option>
            ))}
          </select>
          <select style={field} value={product} onChange={(e) => narrow(setProduct)(e.target.value)}>
            <option value="">Every campaign</option>
            {filters.campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.label} ({c.files})</option>
            ))}
          </select>
          <select style={field} value={days} onChange={(e) => narrow(setDays)(Number(e.target.value))}>
            {AGES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </Card>

      {/* The grid ------------------------------------------------------- */}
      {loading && !data && (
        <div style={{
          display: "grid", gap: 14,
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i}>
              <Skeleton height={160} radius={10} />
              <div style={{ marginTop: 8 }}><Skeleton width="70%" height={12} /></div>
              <div style={{ marginTop: 6 }}><Skeleton width="45%" height={11} /></div>
            </div>
          ))}
        </div>
      )}

      {data && files.length === 0 && (
        <Card>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            {(tab === "generated" ? totals.assets : totals.total)
              ? "Nothing here matches these filters."
              : tab === "generated"
                ? "Nothing has been generated on this database yet."
                : "No creator has delivered anything on this database yet."}
          </div>
        </Card>
      )}

      {files.length > 0 && (
        <div style={{
          display: "grid", gap: 14,
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        }}>
          {files.map((f) => (
            <div
              key={`${f.link_id}-${f.file_name}`}
              style={{
                border: `1px solid ${theme.border}`, borderRadius: 10,
                background: theme.surface, overflow: "hidden",
              }}
            >
              <a
                href={f.url || undefined}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "block", height: 160, background: theme.surfaceAlt,
                  textDecoration: "none", position: "relative",
                }}
              >
                {f.kind === "image" && f.url && (
                  <img
                    src={f.url}
                    alt={f.file_name}
                    loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                )}
                {f.kind === "video" && f.url && (
                  // preload="metadata" so the grid shows a frame without
                  // pulling seventy megabytes per tile.
                  <video
                    src={f.url}
                    preload="metadata"
                    controls
                    style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000" }}
                  />
                )}
                {(!f.url || f.kind === "file") && (
                  <div style={{
                    height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                    color: theme.textMuted, fontSize: 12, textAlign: "center", padding: 12,
                  }}>
                    {f.url ? f.file_name.split(".").pop().toUpperCase() : "Couldn't be signed"}
                  </div>
                )}
              </a>
              <div style={{ padding: "10px 12px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.campaign_title || "(untitled campaign)"}
                </div>
                <div style={{ ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {creatorName(f)} · {f.brand_name?.trim() || "(unnamed brand)"}
                </div>
                <div style={{ ...muted, marginTop: 3 }}>
                  {friendlyDate(f.created)}
                  {tab === "generated"
                    ? `${f.provider ? ` · ${f.provider}` : ""}${f.cost_cents ? ` · ${f.cost_cents}c` : ""}`
                    : size(f.size_bytes) ? ` · ${size(f.size_bytes)}` : ""}
                </div>
                {/* A generated asset has three verdicts on it and they answer
                    different questions: does the brand want it, is it safe,
                    and — the only one about a person — has the creator whose
                    face it is agreed to it. Say the ones that are not yet a
                    plain yes. */}
                {tab === "generated" && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                    {f.creator_review === "pending" &&
                      !["product", "avatar"].includes(f.creator_source) && (
                        <span style={tag(theme, "#B45309")}>awaiting the creator</span>
                      )}
                    {f.creator_review === "declined" && (
                      <span style={tag(theme, "#B91C1C")}>creator declined</span>
                    )}
                    {f.moderation_status === "failed" && (
                      <span style={tag(theme, "#B91C1C")}>
                        moderation{f.moderation_reason ? `: ${f.moderation_reason}` : ""}
                      </span>
                    )}
                    {f.request_status === "failed" && <span style={tag(theme, "#B91C1C")}>request failed</span>}
                    {f.request_status === "partial" && <span style={tag(theme, "#B45309")}>partial request</span>}
                    {f.job_error && <span style={tag(theme, theme.textMuted)} title={f.job_error}>retried</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && files.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
          {more && (
            <Btn size="sm" variant="outline" loading={loading} onClick={() => setOffset(files.length)}>
              Load more
            </Btn>
          )}
          <span style={muted}>
            {files.length} of {data.matched} file{data.matched === 1 ? "" : "s"}
            {(() => {
              const all = tab === "generated" ? totals.assets : totals.total;
              return all != null && data.matched !== all ? ` (${all} in all)` : "";
            })()}
          </span>
        </div>
      )}
    </div>
  );
}
