// Trials — search-first standalone page for non-technical admins to grant
// trials to brands without navigating /users.
//
// Workflow: type a brand name / email / Shopify URL → see top matches with
// their current trial state → click "Grant trial" → friendly modal with
// quick-pick presets + confirm step (see components/trials/GrantTrialModal).
//
// The brand search backend (/admin-users/brands?q=...) substring-matches on
// email, store_name, store_website, first_name, last_name — so an operator
// who only knows "Sephora" or "sephora.com" or "Maria from Sephora" will all
// land on the right row.
//
// Targets the same DB the rest of the ops admin views target (DbTargetContext);
// the modal surfaces a small DEV/PROD pill so accidental dev grants are
// visible at a glance.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Skeleton } from "../components/ui/Skeleton";
import GrantTrialModal from "../components/trials/GrantTrialModal";
import { planLabel } from "../components/trials/planConfig";

export default function TrialsPage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const isDev = target === "dev";

  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [trialModalRow, setTrialModalRow] = useState(null);
  const [toast, setToast] = useState(null); // { brand, plan, days } | null

  // Server-side search — substring matches on email/store_name/website/name.
  // We don't fetch on mount: the page renders empty and prompts the operator
  // to type. A 0-character search would return the most-recent 50 brands,
  // which is rarely the right answer for "I'm looking for X".
  const fetchRows = useCallback(async (term) => {
    if (!term.trim()) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await api.listAdminBrands({ q: term.trim(), limit: 25 });
      setRows(data);
    } catch (err) {
      setError(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounce search so we don't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => fetchRows(q), 300);
    return () => clearTimeout(t);
  }, [q, fetchRows]);

  function onGranted() {
    const r = trialModalRow;
    setTrialModalRow(null);
    if (r) setToast({ brand: r.store_name || r.email, email: r.email });
    fetchRows(q); // refresh so the row shows updated trial state
  }

  // Auto-dismiss toast after 5s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const showResults = q.trim().length > 0;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>
          Grant a trial
        </h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
          Find a brand and re-arm their free trial. Type a brand name, email, or Shopify URL.
        </p>
      </div>

      {/* Search bar */}
      <Card style={{ marginBottom: 16 }}>
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by store name, email, or website (e.g. ‘Sephora’ or ‘maria@sephora.com’)"
          style={{ fontSize: 15 }}
        />
        <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8 }}>
          Searching {isDev ? "DEV database" : "production"}. Use the toggle in the header to switch.
        </div>
      </Card>

      {error && (
        <Card style={{ borderColor: "#DC2626", marginBottom: 12 }}>
          <div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {/* Results */}
      {!showResults ? (
        <Card>
          <div style={{ color: theme.textMuted, fontSize: 13, padding: "20px 0", textAlign: "center" }}>
            Type at least one character above to search for a brand.
          </div>
        </Card>
      ) : loading ? (
        <ResultsSkeleton theme={theme} />
      ) : rows.length === 0 ? (
        <Card>
          <div style={{ color: theme.textMuted, fontSize: 13, padding: "20px 0", textAlign: "center" }}>
            No brands match <b style={{ color: theme.text }}>"{q}"</b>. Try a different name, email, or URL.
          </div>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {rows.map((row, i) => (
            <BrandResultRow
              key={row.user_id}
              row={row}
              theme={theme}
              isLast={i === rows.length - 1}
              onGrantTrial={() => setTrialModalRow(row)}
            />
          ))}
        </Card>
      )}

      <GrantTrialModal
        row={trialModalRow}
        isDev={isDev}
        onClose={() => setTrialModalRow(null)}
        onGranted={onGranted}
      />

      {toast && <SuccessToast toast={toast} theme={theme} onClose={() => setToast(null)} />}
    </div>
  );
}

function BrandResultRow({ row, theme, isLast, onGrantTrial }) {
  const trial = useMemo(() => describeTrial(row, theme), [row, theme]);
  const initials = useMemo(() => initialsFor(row), [row]);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "14px 16px",
      borderBottom: isLast ? "none" : `1px solid ${theme.border}`,
    }}>
      {/* Avatar */}
      <div style={{ flexShrink: 0 }}>
        {row.signed_logo_pic ? (
          <img src={row.signed_logo_pic} alt=""
            style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", display: "block" }} />
        ) : (
          <div style={{
            width: 40, height: 40, borderRadius: 8,
            background: theme.surfaceAlt, color: theme.textMid,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 600,
          }}>{initials}</div>
        )}
      </div>

      {/* Identity */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.store_name || row.email}
        </div>
        <div style={{ fontSize: 12, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.email}{row.store_website ? ` · ${row.store_website}` : ""}
        </div>
      </div>

      {/* Current trial state */}
      <div style={{ minWidth: 200, textAlign: "right" }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: trial.color }}>
          {trial.label}
        </div>
        {trial.subLabel && (
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>
            {trial.subLabel}
          </div>
        )}
      </div>

      {/* Action */}
      <div style={{ flexShrink: 0 }}>
        <Btn size="sm" onClick={onGrantTrial}>Grant trial</Btn>
      </div>
    </div>
  );
}

function describeTrial(row, theme) {
  const plan = row.trial_plan_name || "";
  const days = row.trial_days || 0;
  const activated = row.trial_activation_date && row.trial_activation_date !== "-infinity"
    ? new Date(row.trial_activation_date) : null;
  const expires = row.trial_expiration_date && row.trial_expiration_date !== "-infinity"
    ? new Date(row.trial_expiration_date) : null;
  const isExpired = expires && expires.getTime() <= Date.now();

  if (!plan && !days) {
    return { label: "No trial set", subLabel: null, color: theme.textMuted };
  }
  if (!activated) {
    return {
      label: `Granted · ${planLabel(plan)} ${days}d`,
      subLabel: "Waiting for brand to activate",
      color: theme.textMid,
    };
  }
  if (!isExpired) {
    return {
      label: `Active · ${planLabel(plan)}`,
      subLabel: `ends ${friendlyDate(row.trial_expiration_date)}`,
      color: "#16A34A",
    };
  }
  return {
    label: `Expired · ${planLabel(plan)}`,
    subLabel: `ended ${friendlyDate(row.trial_expiration_date)}`,
    color: "#B91C1C",
  };
}

function initialsFor(row) {
  const name = row.store_name || row.email || "?";
  return name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function ResultsSkeleton({ theme }) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 14,
          padding: "14px 16px",
          borderBottom: i === 4 ? "none" : `1px solid ${theme.border}`,
        }}>
          <Skeleton width={40} height={40} radius={8} />
          <div style={{ flex: 1 }}>
            <Skeleton width="40%" height={12} />
            <div style={{ height: 6 }} />
            <Skeleton width="65%" height={10} />
          </div>
          <Skeleton width={80} height={28} radius={6} />
        </div>
      ))}
    </Card>
  );
}

function SuccessToast({ toast, theme, onClose }) {
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24,
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderLeft: `4px solid #16A34A`, borderRadius: 8,
      padding: "14px 16px", boxShadow: theme.shadowMd,
      maxWidth: 360, zIndex: 1000,
      display: "flex", gap: 12, alignItems: "flex-start",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 2 }}>
          Trial granted
        </div>
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          {toast.brand} — they can now click "Start Free Trial" in the app.
        </div>
      </div>
      <button
        onClick={onClose}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          color: theme.textMuted, fontSize: 16, padding: 0, lineHeight: 1,
        }}
        aria-label="Dismiss"
      >×</button>
    </div>
  );
}
