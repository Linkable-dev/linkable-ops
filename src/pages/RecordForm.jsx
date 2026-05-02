import { useState, useEffect } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyName } from "../lib/api";
import { Btn } from "../components/ui/Button";

export default function RecordForm({ table, id, onSaved, onCancel }) {
  const { theme, mode } = useTheme();
  const isNew = !id;

  const [schema, setSchema] = useState([]);
  const [formData, setFormData] = useState({});
  const [fkOptions, setFkOptions] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSchema(table);
        setSchema(s);

        const fkCols = s.filter((c) => c.fk);
        const fkOpts = {};
        await Promise.all(fkCols.map(async (col) => {
          try { fkOpts[col.column_name] = await api.getFkOptions(col.fk.refTable); } catch {}
        }));
        setFkOptions(fkOpts);

        if (!isNew) {
          const row = await api.getRow(table, id);
          setFormData(row);
        } else {
          const initial = {};
          s.forEach((col) => {
            if (shouldHideInForm(col, true)) return;
            initial[col.column_name] = "";
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
      schema.forEach((col) => {
        if (shouldHideInForm(col, isNew)) delete payload[col.column_name];
        if (payload[col.column_name] === "") {
          if (col.is_nullable === "YES") payload[col.column_name] = null;
          else delete payload[col.column_name];
        }
      });
      if (isNew) {
        await api.createRow(table, payload);
      } else {
        await api.updateRow(table, id, payload);
      }
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 0" }}>
      <div style={{ width: 20, height: 20, border: `2.5px solid ${theme.border}`, borderTopColor: theme.text, borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
    </div>
  );

  const visibleCols = schema.filter((col) => !shouldHideInForm(col, isNew));

  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, marginBottom: 16,
          background: mode === "dark" ? "#3B1111" : "#FEF2F2", border: `1px solid ${mode === "dark" ? "#5C1D1D" : "#FECACA"}`,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span style={{ fontSize: 13, color: "#EF4444" }}>{error}</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 0, maxHeight: "60vh", overflowY: "auto" }}>
        {visibleCols.map((col, i) => (
          <div key={col.column_name} style={{
            padding: "12px 0",
            borderBottom: i < visibleCols.length - 1 ? `1px solid ${theme.border}` : "none",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: theme.textMid }}>
                {friendlyName(col.fk ? col.column_name.replace(/_id$/, "") : col.column_name)}
              </div>
              {col.fk && <span style={{ fontSize: 9, color: theme.textMuted, background: theme.surfaceAlt, padding: "1px 5px", borderRadius: 3 }}>→ {friendlyName(col.fk.refTable)}</span>}
              {col.is_nullable === "NO" && !col.is_primary_key && <span style={{ fontSize: 10, color: "#EF4444" }}>required</span>}
            </div>
            <FieldInput
              col={col} value={formData[col.column_name]}
              onChange={(v) => setFormData((prev) => ({ ...prev, [col.column_name]: v }))}
              disabled={false}
              theme={theme} mode={mode}
              fkData={fkOptions[col.column_name]}
            />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${theme.border}` }}>
        <Btn variant="outline" size="sm" onClick={onCancel}>Cancel</Btn>
        <Btn size="sm" onClick={handleSubmit} loading={saving}>
          {isNew ? "Create" : "Save Changes"}
        </Btn>
      </div>
    </form>
  );
}

/**
 * Hide fields that have DB-level defaults and shouldn't be manually set:
 * - Auto-increment PKs (nextval)
 * - UUID PKs (gen_random_uuid, uuid_generate)
 * - created_at / updated_at / deleted_at with defaults (now(), CURRENT_TIMESTAMP)
 * - Any column with column_default containing "now()" or "CURRENT_TIMESTAMP"
 */
function shouldHideInForm(col, isNew) {
  const def = (col.column_default || "").toLowerCase();
  const name = col.column_name.toLowerCase();

  // Auto-generated PKs
  if (col.is_primary_key && (def.includes("nextval") || def.includes("gen_random_uuid") || def.includes("uuid_generate"))) return true;

  // Timestamp columns with auto defaults
  if ((col.data_type.includes("timestamp") || col.data_type === "date") && (def.includes("now()") || def.includes("current_timestamp"))) return true;

  // Common auto-managed columns
  if (isNew && (name === "created_at" || name === "updated_at" || name === "deleted_at" || name === "inserted_at" || name === "modified_at")) return true;

  // On edit, also hide created_at (shouldn't be changed)
  if (!isNew && (name === "created_at" || name === "inserted_at")) return true;

  // PK on edit shouldn't be editable
  if (!isNew && col.is_primary_key) return true;

  return false;
}

function FieldInput({ col, value, onChange, disabled, theme, mode, fkData }) {
  const type = col.data_type;
  const isBoolean = type === "boolean";
  const isNumber = ["integer", "bigint", "numeric", "real", "double precision", "smallint"].includes(type);
  const isText = type === "text";
  const isJson = type === "json" || type === "jsonb";
  const isTimestamp = type.includes("timestamp") || type === "date";
  const isEmail = col.column_name.toLowerCase().includes("email");
  const isUrl = col.column_name.toLowerCase().includes("url") || col.column_name.toLowerCase().includes("website") || col.column_name.toLowerCase().includes("link");
  const isPhone = col.column_name.toLowerCase().includes("phone");

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
      <div>
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : (isNumber ? Number(e.target.value) : e.target.value))}
          disabled={disabled}
          style={{
            ...inputStyle, paddingRight: 36, appearance: "none", WebkitAppearance: "none",
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='${encodeURIComponent(theme.textMuted)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center",
          }}
        >
          <option value="">— Select —</option>
          {fkData.options.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label || `#${opt.id}`}</option>
          ))}
        </select>
        {value && (
          <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 3, fontFamily: "monospace" }}>ID: {value}</div>
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

  // JSON — pretty textarea with format button
  if (isJson) {
    const [formatted, setFormatted] = useState(false);
    const formatJson = () => {
      try {
        const obj = typeof value === "string" ? JSON.parse(value) : value;
        onChange(JSON.stringify(obj, null, 2));
        setFormatted(true);
        setTimeout(() => setFormatted(false), 1500);
      } catch {}
    };
    return (
      <div style={{ position: "relative" }}>
        <textarea value={typeof value === "object" ? JSON.stringify(value, null, 2) : (value ?? "")} onChange={(e) => onChange(e.target.value)} disabled={disabled} rows={5}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12 }} />
        <button type="button" onClick={formatJson} style={{
          position: "absolute", top: 6, right: 6, padding: "3px 8px", borderRadius: 4,
          border: `1px solid ${theme.border}`, background: theme.surfaceAlt, color: theme.textMid,
          fontSize: 10, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
        }}>{formatted ? "✓ Formatted" : "Format"}</button>
      </div>
    );
  }

  // Long text
  if (isText) {
    return (
      <textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} rows={3}
        style={{ ...inputStyle, resize: "vertical" }} />
    );
  }

  // Timestamp / date
  if (isTimestamp) {
    return (
      <div>
        <input type="datetime-local" value={value ? value.slice(0, 16) : ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} style={inputStyle} />
        {value && <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 3 }}>{new Date(value).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}</div>}
      </div>
    );
  }

  // Email
  if (isEmail) {
    return <input type="email" value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="email@example.com" style={inputStyle} />;
  }

  // URL
  if (isUrl) {
    return (
      <div>
        <input type="url" value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="https://..." style={inputStyle} />
        {value && (
          <a href={value} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: theme.textMuted, marginTop: 3, display: "inline-block", textDecoration: "underline" }}>
            Open link ↗
          </a>
        )}
      </div>
    );
  }

  // Phone
  if (isPhone) {
    return <input type="tel" value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder="+1 (555) 123-4567" style={inputStyle} />;
  }

  // Number
  if (isNumber) {
    return <input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} disabled={disabled} style={inputStyle} />;
  }

  // Default text
  return <input type="text" value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} style={inputStyle} />;
}
