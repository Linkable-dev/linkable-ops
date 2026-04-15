import { useState, useEffect } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import { friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";

export default function TeamPage() {
  const themeCtx = useTheme();
  const authCtx = useAuth();
  const t = themeCtx.theme;
  const m = themeCtx.mode;

  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [newPwd, setNewPwd] = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdError, setPwdError] = useState(null);
  const [pwdSuccess, setPwdSuccess] = useState(false);

  const fetchAdmins = async () => {
    try {
      const res = await fetch("/api/auth/admins", {
        headers: { Authorization: `Bearer ${await authCtx.getToken()}` },
      });
      if (res.ok) setAdmins(await res.json());
    } catch {}
    finally { setLoading(false); }
  };

  useEffect(() => { fetchAdmins(); }, []);

  const handleInvite = async (e) => {
    e.preventDefault();
    setInviting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await authCtx.getToken()}` },
        body: JSON.stringify({ email: inviteEmail, name: inviteName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInviteOpen(false);
      fetchAdmins();
    } catch (err) { setError(err.message); }
    finally { setInviting(false); }
  };

  const handleRemove = async (id) => {
    try {
      await fetch(`/api/auth/admins/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await authCtx.getToken()}` },
      });
      setDeleteConfirm(null);
      fetchAdmins();
    } catch {}
  };



  const handleChangePwd = async (e) => {
    e.preventDefault();
    if (newPwd.length < 6) { setPwdError("Password must be at least 6 characters"); return; }
    setPwdLoading(true);
    setPwdError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPwd });
      if (error) throw error;
      setPwdSuccess(true);
      setNewPwd("");
      setTimeout(() => { setPwdOpen(false); setPwdSuccess(false); }, 1500);
    } catch (err) { setPwdError(err.message); }
    finally { setPwdLoading(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 12, color: t.textMuted }}>{admins.length} team members</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" variant="outline" onClick={() => { setPwdOpen(true); setPwdError(null); setPwdSuccess(false); setNewPwd(""); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            Change Password
          </Btn>
          <Btn size="sm" onClick={() => { setInviteOpen(true); setInviteEmail(""); setInviteName(""); setError(null); }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
            Invite Admin
          </Btn>
        </div>
      </div>

      <Card style={{ padding: 0, marginBottom: 0 }}>
        {loading ? (
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <Skeleton width={32} height={32} radius={999} />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  <Skeleton width={`${40 + (i * 11) % 40}%`} height={12} />
                  <Skeleton width={`${30 + (i * 7) % 30}%`} height={10} />
                </div>
                <Skeleton width={60} height={18} radius={10} />
              </div>
            ))}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${t.border}`, background: t.surfaceAlt }}>
                <th style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Name</th>
                <th style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Email</th>
                <th style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Status</th>
                <th style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Last Active</th>
                <th style={{ padding: "10px 16px", width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} style={{ borderBottom: `1px solid ${t.border}` }}
                  onMouseEnter={(e) => e.currentTarget.style.background = t.accentLight}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                        background: m === "dark" ? "#333" : "#0A0A0A", color: "#fff",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 700,
                      }}>{(a.name || a.email)[0].toUpperCase()}</div>
                      <div>
                        <div style={{ fontWeight: 500, color: t.text }}>{a.name || "—"}</div>
                        {a.role === "owner" && <span style={{ fontSize: 10, color: t.textMuted, background: t.surfaceAlt, padding: "1px 5px", borderRadius: 3 }}>Owner</span>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px", color: t.textMid }}>{a.email}</td>
                  <td style={{ padding: "12px 16px" }}>
                    {a.last_login ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#22C55E", fontWeight: 500 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22C55E" }} />
                        Active
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#F59E0B", fontWeight: 500 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#F59E0B" }} />
                        Invited
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "12px 16px", color: t.textMuted, fontSize: 12 }}>
                    {a.last_login ? friendlyDate(a.last_login) : "Never"}
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}>
                    {a.id !== authCtx.admin?.id && !(a.role === "owner" && authCtx.admin?.role !== "owner") && (
                      <button onClick={() => setDeleteConfirm(a)} style={{
                        background: "none", border: "none", cursor: "pointer", color: t.textMuted, padding: 4,
                      }}
                        onMouseEnter={(e) => e.currentTarget.style.color = "#EF4444"}
                        onMouseLeave={(e) => e.currentTarget.style.color = t.textMuted}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Invite Modal */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite Admin" width={440}>
        <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 16 }}>
          Add their email to grant access. They'll be able to sign in with their Supabase account.
        </div>
        <form onSubmit={handleInvite}>
            {error && (
              <div style={{
                padding: "10px 14px", borderRadius: 8, marginBottom: 16,
                background: m === "dark" ? "#3B1111" : "#FEF2F2",
                border: `1px solid ${m === "dark" ? "#5C1D1D" : "#FECACA"}`,
                fontSize: 13, color: "#EF4444",
              }}>{error}</div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: t.textMid, display: "block", marginBottom: 6 }}>Email</label>
              <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@linkable.link" required style={{
                width: "100%", boxSizing: "border-box", padding: "9px 13px", borderRadius: 8,
                border: `1.5px solid ${t.border}`, background: t.bg, color: t.text,
                fontFamily: "inherit", fontSize: 13, outline: "none",
              }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: t.textMid, display: "block", marginBottom: 6 }}>Name <span style={{ color: t.textMuted, fontWeight: 400 }}>(optional)</span></label>
              <input type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Their name" style={{
                width: "100%", boxSizing: "border-box", padding: "9px 13px", borderRadius: 8,
                border: `1.5px solid ${t.border}`, background: t.bg, color: t.text,
                fontFamily: "inherit", fontSize: 13, outline: "none",
              }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn size="sm" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Btn>
              <Btn size="sm" onClick={handleInvite} disabled={inviting}>
                {inviting ? "Adding..." : "Add Admin"}
              </Btn>
            </div>
          </form>
      </Modal>

      {/* Remove confirmation */}
      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Remove Admin" width={400}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: t.text }}>
            Remove <strong>{deleteConfirm?.name || deleteConfirm?.email}</strong> from the team? They'll lose access immediately.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn size="sm" variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Btn>
          <button onClick={() => handleRemove(deleteConfirm?.id)} style={{
            padding: "7px 18px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 600,
            background: "#EF4444", color: "#fff", cursor: "pointer", fontFamily: "inherit",
          }}>Remove</button>
        </div>
      </Modal>

      {/* Change Password */}
      <Modal open={pwdOpen} onClose={() => setPwdOpen(false)} title="Change Password" width={400}>
        {pwdSuccess ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span style={{ fontSize: 14, fontWeight: 500, color: "#22C55E" }}>Password updated!</span>
          </div>
        ) : (
          <form onSubmit={handleChangePwd}>
            {pwdError && (
              <div style={{
                padding: "10px 14px", borderRadius: 8, marginBottom: 16,
                background: m === "dark" ? "#3B1111" : "#FEF2F2",
                border: `1px solid ${m === "dark" ? "#5C1D1D" : "#FECACA"}`,
                fontSize: 13, color: "#EF4444",
              }}>{pwdError}</div>
            )}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: t.textMid, display: "block", marginBottom: 6 }}>New Password</label>
              <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="At least 6 characters" required minLength={6} autoFocus style={{
                width: "100%", boxSizing: "border-box", padding: "9px 13px", borderRadius: 8,
                border: `1.5px solid ${t.border}`, background: t.bg, color: t.text,
                fontFamily: "inherit", fontSize: 13, outline: "none",
              }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn size="sm" variant="outline" onClick={() => setPwdOpen(false)}>Cancel</Btn>
              <Btn size="sm" onClick={handleChangePwd} disabled={pwdLoading}>
                {pwdLoading ? "Updating..." : "Update Password"}
              </Btn>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
