import { useState, useEffect, useCallback } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { Label, SectionTitle, Row, Col } from "../../components/ui/Label";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import { useTheme } from "../../contexts/ThemeContext";

export default function SettingsPage() {
  const { theme, mode } = useTheme();
  const { profile, team, user } = useAuth();
  const teamId = profile?.team_id;
  const isOwner = profile?.role === "owner";
  const isAdmin = profile?.role === "admin" || isOwner;
  const accent = theme.accent;

  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchMembers = useCallback(async () => {
    if (!teamId) return;
    const { data } = await supabase.from("profiles").select("*").eq("team_id", teamId).order("created_at", { ascending: true });
    setMembers(data || []);
  }, [teamId]);

  const fetchInvitations = useCallback(async () => {
    if (!teamId) return;
    const { data } = await supabase.from("team_invitations").select("*").eq("team_id", teamId).is("accepted_at", null).order("created_at", { ascending: false });
    setInvitations(data || []);
  }, [teamId]);

  useEffect(() => {
    if (!teamId) return;
    setLoading(true);
    Promise.all([fetchMembers(), fetchInvitations()]).finally(() => setLoading(false));
  }, [fetchMembers, fetchInvitations, teamId]);

  async function handleRoleChange(memberId, newRole) {
    if (!isOwner) return;
    await supabase.from("profiles").update({ role: newRole }).eq("id", memberId);
    setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role: newRole } : m));
  }

  async function handleSendInvite() {
    if (!inviteEmail.trim()) { setInviteError("Email is required"); return; }
    setInviteLoading(true); setInviteError(""); setInviteSuccess("");
    const token = crypto.randomUUID();
    const { error } = await supabase.from("team_invitations").insert({
      team_id: teamId, email: inviteEmail.trim().toLowerCase(), role: inviteRole,
      token, invited_by: user.id,
    });
    if (error) { setInviteError(error.message); }
    else {
      setInviteSuccess(`${window.location.origin}/invite/${token}`);
      setInviteEmail(""); setInviteRole("member"); fetchInvitations();
    }
    setInviteLoading(false);
  }

  async function handleRevokeInvite(inviteId) {
    await supabase.from("team_invitations").delete().eq("id", inviteId);
    setInvitations(prev => prev.filter(inv => inv.id !== inviteId));
  }

  // Styled select that works in both light and dark
  const selectStyle = {
    width: "100%", padding: "10px 36px 10px 13px", borderRadius: 8,
    border: `1.5px solid ${theme.border}`, backgroundColor: theme.bg,
    fontFamily: "inherit", fontSize: 14, color: theme.text,
    appearance: "none", WebkitAppearance: "none",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='${encodeURIComponent(theme.textMuted)}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center",
    cursor: "pointer", boxSizing: "border-box",
  };

  const smallSelectStyle = {
    ...selectStyle, padding: "5px 28px 5px 8px", fontSize: 12, borderRadius: 6,
    backgroundPosition: "right 8px center",
  };

  const thStyle = { textAlign: "left", padding: "10px 12px", fontWeight: 600, color: theme.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `2px solid ${theme.border}` };
  const tdStyle = { padding: "12px 12px", color: theme.text, borderBottom: `1px solid ${theme.border}`, fontSize: 13 };

  return (
    <div>
      {loading ? (
        <Card><div style={{ textAlign: "center", color: theme.textMuted, padding: 24 }}>Loading...</div></Card>
      ) : (
        <>
          {/* Team Info */}
          <Card>
            <SectionTitle>Team Information</SectionTitle>
            <Row>
              <Col>
                <Label>Team Name</Label>
                <div style={{ fontSize: 16, fontWeight: 600, color: theme.text, padding: "8px 0" }}>{team?.name || "No team"}</div>
              </Col>
              <Col>
                <Label>Slug</Label>
                <div style={{ fontSize: 14, color: theme.textMid, padding: "8px 0", fontFamily: "monospace", background: theme.surfaceAlt, borderRadius: 6, padding: "8px 12px", display: "inline-block" }}>{team?.slug || "-"}</div>
              </Col>
            </Row>
            <Row>
              <Col>
                <Label>Your Role</Label>
                <Tag color={theme.textMid}>{profile?.role || "member"}</Tag>
              </Col>
              <Col>
                <Label>Members</Label>
                <div style={{ fontSize: 16, fontWeight: 600, color: theme.text, padding: "4px 0" }}>{members.length}</div>
              </Col>
            </Row>
          </Card>

          {/* Team Members */}
          <Card>
            <SectionTitle>Team Members</SectionTitle>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Email</th>
                    <th style={thStyle}>Role</th>
                    <th style={thStyle}>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map(m => (
                    <tr key={m.id}>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 600 }}>{m.full_name || m.email || "Unnamed"}</span>
                        {m.id === user.id && <span style={{ color: theme.textMuted, fontSize: 11, marginLeft: 6 }}>(you)</span>}
                      </td>
                      <td style={tdStyle}>{m.email || "-"}</td>
                      <td style={tdStyle}>
                        {isOwner && m.id !== user.id ? (
                          <select value={m.role} onChange={e => handleRoleChange(m.id, e.target.value)} style={smallSelectStyle}>
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                            <option value="owner">Owner</option>
                          </select>
                        ) : (
                          <Tag color={theme.textMid}>{m.role}</Tag>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: theme.textMuted }}>{m.created_at ? new Date(m.created_at).toLocaleDateString() : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Invite */}
          {isAdmin && (
            <Card>
              <SectionTitle>Invite New Member</SectionTitle>
              <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <Label>Email Address</Label>
                  <Input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="colleague@company.com" />
                </div>
                <div style={{ minWidth: 140 }}>
                  <Label>Role</Label>
                  <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} style={selectStyle}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div style={{ paddingBottom: 0 }}>
                  <Btn onClick={handleSendInvite} disabled={inviteLoading}>
                    {inviteLoading ? "Sending..." : "Send Invite"}
                  </Btn>
                </div>
              </div>
              {inviteError && <div style={{ color: "#EF4444", fontSize: 13, marginTop: 12 }}>{inviteError}</div>}
              {inviteSuccess && (
                <div style={{
                  marginTop: 12, padding: "12px 14px", borderRadius: 8, fontSize: 13, wordBreak: "break-all",
                  background: mode === "dark" ? "#052e16" : "#F0FDF4",
                  border: `1px solid ${mode === "dark" ? "#14532d" : "#BBF7D0"}`,
                  color: mode === "dark" ? "#4ADE80" : "#166534",
                }}>
                  Invite link copied — share with your teammate:<br/>
                  <span style={{ fontFamily: "monospace", fontSize: 12 }}>{inviteSuccess}</span>
                </div>
              )}
            </Card>
          )}

          {/* Pending Invitations */}
          {isAdmin && invitations.length > 0 && (
            <Card>
              <SectionTitle>Pending Invitations</SectionTitle>
              {invitations.map(inv => (
                <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${theme.border}` }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: theme.text }}>{inv.email}</div>
                    <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>
                      <Tag color={theme.textMid}>{inv.role}</Tag>
                      <span style={{ marginLeft: 8 }}>Invited {new Date(inv.created_at).toLocaleDateString()}</span>
                    </div>
                    <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4, fontFamily: "monospace", wordBreak: "break-all" }}>
                      {window.location.origin}/invite/{inv.token}
                    </div>
                  </div>
                  <Btn size="sm" color="#EF4444" variant="outline" onClick={() => handleRevokeInvite(inv.id)}>Revoke</Btn>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
