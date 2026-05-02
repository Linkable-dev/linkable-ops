import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyName, friendlyDate } from "../lib/api";
import { Btn } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

export default function RecordPage() {
  const { table, id } = useParams();
  const navigate = useNavigate();
  const { theme, mode } = useTheme();
  const isNew = !id;

  const [schema, setSchema] = useState([]);
  const [formData, setFormData] = useState({});
  const [fkOptions, setFkOptions] = useState({}); // { colName: { pk, labelCol, options: [{id, label}] } }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSchema(table);
        setSchema(s);

        // Load FK options for all FK columns
        const fkCols = s.filter((c) => c.fk);
        const fkOpts = {};
        await Promise.all(
          fkCols.map(async (col) => {
            try {
              const opts = await api.getFkOptions(col.fk.refTable);
              fkOpts[col.column_name] = opts;
            } catch {}
          })
        );
        setFkOptions(fkOpts);

        if (!isNew) {
          const row = await api.getRow(table, id);
          setFormData(row);
        } else {
          const initial = {};
          s.forEach((col) => {
            if (!col.is_primary_key || !col.column_default?.includes("nextval")) {
              initial[col.column_name] = "";
            }
          });
          setFormData(initial);
        }
      } catch (err) { setError(err.message); }
      finally { setLoading(false); }
    })();
  }, [table, id, isNew]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = { ...formData };
      if (isNew) {
        schema.forEach((col) => {
          if (col.is_primary_key && col.column_default?.includes("nextval")) delete payload[col.column_name];
          if (payload[col.column_name] === "") {
            if (col.is_nullable === "YES") payload[col.column_name] = null;
            else delete payload[col.column_name];
          }
        });
      }
      if (isNew) {
        const created = await api.createRow(table, payload);
        setSuccess(true);
        const pkCol = schema.find((c) => c.is_primary_key)?.column_name;
        setTimeout(() => navigate(`/tables/${table}/${pkCol ? created[pkCol] : ""}`), 800);
      } else {
        await api.updateRow(table, id, payload);
        setSuccess(true);
        setTimeout(() => setSuccess(false), 2000);
      }
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}>
      <div style={{ width: 24, height: 24, border: `2.5px solid ${theme.border}`, borderTopColor: theme.text, borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
    </div>
  );

  const editableCols = schema.filter((col) => {
    if (isNew && col.is_primary_key && col.column_default?.includes("nextval")) return false;
    if (isNew && col.is_primary_key && col.column_default?.includes("gen_random_uuid")) return false;
    return true;
  });

  return (
    <div style={{ maxWidth: 640 }}>
      <Link to={`/tables/${table}`} style={{
        display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none",
        color: theme.textMid, fontSize: 13, marginBottom: 20,
      }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3L5 8l5 5" />
        </svg>
        Back to {friendlyName(table)}
      </Link>

      {error && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderRadius: 8, marginBottom: 16,
          background: mode === "dark" ? "#3B1111" : "#FEF2F2", border: `1px solid ${mode === "dark" ? "#5C1D1D" : "#FECACA"}`,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span style={{ fontSize: 13, color: "#EF4444" }}>{error}</span>
        </div>
      )}

      {success && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderRadius: 8, marginBottom: 16,
          background: mode === "dark" ? "#052e16" : "#F0FDF4", border: `1px solid ${mode === "dark" ? "#14532d" : "#BBF7D0"}`,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span style={{ fontSize: 13, color: "#22C55E" }}>
            {isNew ? "Record created!" : "Record updated!"}
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Card style={{ padding: 0, marginBottom: 0 }}>
          {editableCols.map((col, i) => (
            <div key={col.column_name} style={{
              padding: "16px 20px",
              borderBottom: i < editableCols.length - 1 ? `1px solid ${theme.border}` : "none",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: theme.textMid }}>{friendlyName(col.column_name)}</div>
                {col.fk && <span style={{ fontSize: 9, color: theme.textMuted, background: theme.surfaceAlt, padding: "1px 5px", borderRadius: 3 }}>→ {friendlyName(col.fk.refTable)}</span>}
                {col.is_nullable === "NO" && !col.is_primary_key && <span style={{ fontSize: 10, color: "#EF4444" }}>required</span>}
                {col.is_primary_key && (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: theme.accentLight, color: theme.textMid }}>PK</span>
                )}
              </div>
              <FieldInput
                col={col}
                value={formData[col.column_name]}
                onChange={(v) => setFormData((prev) => ({ ...prev, [col.column_name]: v }))}
                disabled={!isNew && col.is_primary_key}
                theme={theme}
                mode={mode}
                fkData={fkOptions[col.column_name]}
              />
            </div>
          ))}

          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10,
            padding: "14px 20px", borderTop: `1px solid ${theme.border}`, background: theme.surfaceAlt,
            borderRadius: "0 0 10px 10px",
          }}>
            <Link to={`/tables/${table}`} style={{ textDecoration: "none" }}>
              <Btn variant="outline" size="sm">Cancel</Btn>
            </Link>
            <Btn size="sm" onClick={handleSubmit} loading={saving}>
              {isNew ? "Create" : "Save Changes"}
            </Btn>
          </div>
        </Card>
      </form>
    </div>
  );
}

function FieldInput({ col, value, onChange, disabled, theme, mode, fkData }) {
  const type = col.data_type;
  const isBoolean = type === "boolean";
  const isNumber = ["integer", "bigint", "numeric", "real", "double precision", "smallint"].includes(type);
  const isText = type === "text";
  const isJson = type === "json" || type === "jsonb";
  const isTimestamp = type.includes("timestamp") || type === "date";

  const inputStyle = {
    width: "100%", boxSizing: "border-box", background: theme.bg,
    border: `1.5px solid ${theme.border}`, borderRadius: 8, color: theme.text,
    fontFamily: "inherit", fontSize: 13, padding: "9px 13px",
    outline: "none", lineHeight: 1.6, transition: "background 0.2s, border-color 0.2s, color 0.2s",
    opacity: disabled ? 0.5 : 1,
  };

  // FK dropdown
  if (col.fk && fkData?.options) {
    return (
      <div style={{ position: "relative" }}>
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : (isNumber ? Number(e.target.value) : e.target.value))}
          disabled={disabled}
          style={{
            ...inputStyle,
            paddingRight: 36,
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='${encodeURIComponent(theme.textMuted)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 12px center",
            appearance: "none",
            WebkitAppearance: "none",
          }}
        >
          <option value="">— Select —</option>
          {fkData.options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label || `#${opt.id}`}
            </option>
          ))}
        </select>
        {value && (
          <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 3, fontFamily: "monospace" }}>
            ID: {value}
          </div>
        )}
      </div>
    );
  }

  // Boolean toggle
  if (isBoolean) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" onClick={() => !disabled && onChange(!value)} disabled={disabled} style={{
          width: 40, height: 22, borderRadius: 11, border: "none", cursor: disabled ? "not-allowed" : "pointer",
          background: value ? theme.accent : theme.border, position: "relative", transition: "background 0.15s",
        }}>
          <span style={{
            position: "absolute", top: 2, left: value ? 20 : 2,
            width: 18, height: 18, borderRadius: "50%", background: value ? (mode === "dark" ? "#0A0A0A" : "#fff") : theme.surface,
            transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }} />
        </button>
        <span style={{ fontSize: 13, color: theme.textMid }}>{value ? "Yes" : "No"}</span>
      </div>
    );
  }

  // Text / JSON textarea
  if (isText || isJson) {
    return (
      <textarea
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={4}
        style={{ ...inputStyle, resize: "vertical", fontFamily: isJson ? "monospace" : "inherit", fontSize: isJson ? 12 : 13 }}
      />
    );
  }

  // Timestamp — show friendly date alongside input
  if (isTimestamp) {
    return (
      <div>
        <input
          type="datetime-local"
          value={value ? value.slice(0, 16) : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          style={inputStyle}
        />
        {value && (
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 3 }}>
            {new Date(value).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
          </div>
        )}
      </div>
    );
  }

  return (
    <input
      type={isNumber ? "number" : "text"}
      value={value ?? ""}
      onChange={(e) => onChange(isNumber ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
      disabled={disabled}
      style={inputStyle}
    />
  );
}
