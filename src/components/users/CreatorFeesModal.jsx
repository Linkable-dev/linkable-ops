// A creator's fees in their 48 hour hold, from the "Held fees" button on the
// Users > Creators rows. A promotion fee is charged to the brand and waits 48
// hours after her post link before it is sent to her; "Stop fee" stops one in
// that window: nothing goes to her and the brand's card is refunded in full
// (fee + 5% service fee), through the main app's StopCreatorFee.
//
// Fees already stopped are listed under the held ones. Paged on the server.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate, friendlyName } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/Button";
import { Pagination } from "../ui/Pagination";
import { useConfirm } from "../ui/ConfirmDialog";
import { useNow } from "../../lib/useNow";

// Minor units to "£52.50", using the currency's own number of decimals.
function formatMinor(minor, currency) {
  const code = (currency || "").toUpperCase();
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: code || "GBP" });
    const digits = fmt.resolvedOptions().maximumFractionDigits;
    return fmt.format((Number(minor) || 0) / 10 ** digits);
  } catch {
    return `${((Number(minor) || 0) / 100).toFixed(2)} ${code}`.trim();
  }
}

function holdLabel(releaseAt, now) {
  if (!releaseAt) return "Hold ends 48 hours after the post link";
  const ms = new Date(releaseAt).getTime() - now;
  if (ms <= 0) return "Hold over, not sent to her yet";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `Hold ends in ${hours}h (${new Date(releaseAt).toLocaleString()})`;
  return `Hold ends in ${Math.max(1, Math.ceil(ms / 60_000))}m`;
}

export default function CreatorFeesModal({ row, label, onClose, onChanged }) {
  const { theme, mode } = useTheme();
  const now = useNow();
  const { ask, dialog: confirmDialog } = useConfirm();
  const [data, setData] = useState(null); // { available, can_stop, items, total }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stopping, setStopping] = useState(null); // fee id
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const userId = row?.user_id;

  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!userId) return;
    const id = ++latest.current;
    setLoading(true);
    setError("");
    try {
      const out = await api.listCreatorFees(userId, { limit: pageSize, offset: (page - 1) * pageSize });
      if (id === latest.current) setData(out);
    } catch (err) {
      if (id === latest.current) setError(err.message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [userId, page, pageSize]);

  useEffect(() => { setData(null); setNotice(""); setError(""); setPage(1); }, [userId]);
  useEffect(() => { load(); }, [load]);

  if (!row) return null;

  async function stopFee(fee) {
    const amount = formatMinor(fee.fee_minor, fee.currency);
    const total = formatMinor(fee.total_minor, fee.currency);
    const reason = await ask({
      title: "Stop this fee?",
      body: `Stop ${label}'s ${amount} fee and refund ${fee.brand_name || "the brand"} ${total}? Nothing goes to the creator.`,
      confirmLabel: "Stop fee",
      danger: true,
      prompt: { placeholder: "Why? (optional, kept with the fee)" },
    });
    if (reason === null || reason === false) return;
    setError("");
    setNotice("");
    setStopping(fee.id);
    try {
      const out = await api.stopCreatorFee(fee.id, (reason || "").trim());
      setNotice(out.status === "refunded"
        ? `Refunded ${formatMinor(out.refunded_minor || fee.total_minor, out.currency || fee.currency)} to ${fee.brand_name || "the brand"}. Nothing goes to ${label}.`
        : `Stopped. Nothing goes to ${label}; the refund to ${fee.brand_name || "the brand"} is retried automatically.`);
      onChanged?.(row.user_id, { held: -1, stopped: 1 });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setStopping(null);
    }
  }

  const items = data?.items || [];
  const held = items.filter((f) => f.state === "held");
  const stopped = items.filter((f) => f.state !== "held");
  const canStop = !!data?.can_stop;

  const cardStyle = {
    border: `1px solid ${theme.border}`, borderRadius: 10, padding: "12px 14px", background: theme.bg,
    display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14,
  };
  const titleStyle = { fontSize: 13, fontWeight: 600, color: theme.text, overflow: "hidden", textOverflow: "ellipsis" };
  const hintStyle = { fontSize: 12, color: theme.textMuted, lineHeight: 1.5 };
  const sectionLabel = { fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: theme.textMuted };
  const banner = (ok) => ({
    fontSize: 12, padding: "10px 12px", borderRadius: 8,
    color: ok ? (mode === "dark" ? "#86EFAC" : "#14532D") : "#EF4444",
    background: ok ? (mode === "dark" ? "#0B3A2A" : "#DCFCE7") : (mode === "dark" ? "#3B1111" : "#FEF2F2"),
    border: `1px solid ${ok ? (mode === "dark" ? "#14532D" : "#BBF7D0") : (mode === "dark" ? "#5B1717" : "#FECACA")}`,
  });

  return (
    <>
      <Modal
        open={!!row}
        // Escape belongs to the confirm while it is open.
        onClose={() => { if (!confirmDialog) onClose(); }}
        title={`Held fees — ${label}`}
        width={620}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={hintStyle}>
            A fee waits 48 hours after her post link before it is sent to her. Stopping one sends
            her nothing and refunds the brand&apos;s card in full, the 5% service fee included.
          </div>

          {notice && <div style={banner(true)}>{notice}</div>}
          {error && <div style={banner(false)}>{error}</div>}
          {data && data.available && !canStop && (
            <div style={banner(false)}>
              Stopping a fee needs the main app connection (MAIN_APP_SERVICE_KEY). It isn&apos;t set on this ops server.
            </div>
          )}

          {!data && loading && <div style={hintStyle}>Loading her fees…</div>}
          {data && !data.available && (
            <div style={hintStyle}>This database has no fee hold yet. It arrives with the next promotion.</div>
          )}
          {data && data.available && items.length === 0 && (
            <div style={hintStyle}>No fees waiting in their hold, and none stopped.</div>
          )}

          {held.length > 0 && <div style={sectionLabel}>In the 48h hold</div>}
          {held.map((fee) => (
            <div key={fee.id} style={cardStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={titleStyle}>{fee.campaign || "Campaign"}{fee.brand_name ? ` · ${fee.brand_name}` : ""}</div>
                <div style={hintStyle}>
                  Fee {formatMinor(fee.fee_minor, fee.currency)} · brand paid {formatMinor(fee.total_minor, fee.currency)}
                  {fee.charged_at ? ` · charged ${friendlyDate(fee.charged_at)}` : ""}
                </div>
                <div style={hintStyle}>{holdLabel(fee.release_at, now)}</div>
                {fee.report && (
                  <div style={{ ...hintStyle, color: "#D97706" }}>
                    Brand reported a problem {friendlyDate(fee.report.created)}: {friendlyName(fee.report.reason)}
                    {fee.report.note ? ` — ${fee.report.note}` : ""}
                  </div>
                )}
              </div>
              <Btn
                size="sm"
                variant="outline"
                color="#DC2626"
                onClick={() => stopFee(fee)}
                loading={stopping === fee.id}
                disabled={!canStop || (stopping && stopping !== fee.id)}
                title={canStop ? "Refund the brand in full and send the creator nothing" : "Needs the main app connection (MAIN_APP_SERVICE_KEY)"}
                style={{ flexShrink: 0 }}
              >
                Stop fee
              </Btn>
            </div>
          ))}

          {stopped.length > 0 && <div style={sectionLabel}>Stopped</div>}
          {stopped.map((fee) => (
            <div key={fee.id} style={cardStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={titleStyle}>{fee.campaign || "Campaign"}{fee.brand_name ? ` · ${fee.brand_name}` : ""}</div>
                <div style={hintStyle}>
                  {fee.state === "stopped"
                    ? `Refunded ${formatMinor(fee.total_minor, fee.currency)} to the brand`
                    : "Stopped; the refund is retried automatically"}
                  {` · fee ${formatMinor(fee.fee_minor, fee.currency)}`}
                </div>
                <div style={hintStyle}>
                  Stopped {friendlyDate(fee.stopped_at)}{fee.stopped_by ? ` by ${fee.stopped_by}` : ""}
                  {fee.stop_reason ? `: ${fee.stop_reason}` : ""}
                </div>
              </div>
            </div>
          ))}

          {data?.available && data.total > pageSize && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={data.total}
              onPageChange={setPage}
              onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
            />
          )}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn size="md" variant="outline" onClick={onClose}>Close</Btn>
          </div>
        </div>
      </Modal>
      {confirmDialog}
    </>
  );
}
