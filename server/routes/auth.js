import express from "express";
import crypto from "crypto";
import { cloudSqlQuery as cloudSqlQueryRaw } from "../lib/cloudsql.js";
import { supabase } from "../lib/supabase.js";
import { parseColumnFilters } from "../lib/tableQuery.js";

// `ops_admins` lives in the prod DB only — pin every query in this file to
// prod so flipping the UI's dev toggle never locks an admin out or queries a
// non-existent dev table.
const cloudSqlQuery = (text, params) => cloudSqlQueryRaw(text, params, "prod");

// Inline middleware for use inside the auth router
async function requireOpsAdminInline(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });
    const { rows } = await cloudSqlQuery(
      `SELECT id, email, name, role FROM ops_admins WHERE LOWER(email) = LOWER($1)`, [user.email]
    );
    if (rows.length === 0) return res.status(403).json({ error: "Not an admin" });
    req.admin = rows[0];
    next();
  } catch { res.status(500).json({ error: "Auth check failed" }); }
}

export function authRoutes() {
  const router = express.Router();

  // Check if current Supabase user is an allowed admin
  router.get("/me", async (req, res) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: "Invalid token" });

      // Check whitelist
      const { rows } = await cloudSqlQuery(
        `SELECT id, email, name, role FROM ops_admins WHERE LOWER(email) = LOWER($1)`,
        [user.email]
      );

      if (rows.length === 0) {
        // Check if any admins exist — if not, auto-add as owner
        const { rows: countRows } = await cloudSqlQuery(`SELECT COUNT(*) as c FROM ops_admins`);
        if (parseInt(countRows[0].c) === 0) {
          const { rows: newAdmin } = await cloudSqlQuery(
            `INSERT INTO ops_admins (email, name, role) VALUES (LOWER($1), $2, 'owner') RETURNING id, email, name, role`,
            [user.email, user.user_metadata?.full_name || user.email.split("@")[0]]
          );
          await cloudSqlQuery(`UPDATE ops_admins SET last_login = NOW() WHERE id = $1`, [newAdmin[0].id]);
          return res.json(newAdmin[0]);
        }
        return res.status(403).json({ error: "You don't have access to this admin panel" });
      }

      await cloudSqlQuery(`UPDATE ops_admins SET last_login = NOW() WHERE id = $1`, [rows[0].id]);
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public: validate invite token
  router.get("/invite/:token", async (req, res) => {
    try {
      const { rows } = await cloudSqlQuery(
        `SELECT email, name FROM ops_admins WHERE invite_token = $1 AND invite_expires > NOW()`,
        [req.params.token]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Invite not found or expired" });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public: accept invite — create Supabase user + set password
  router.post("/accept-invite", async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    try {
      const { rows } = await cloudSqlQuery(
        `SELECT id, email, name FROM ops_admins WHERE invite_token = $1 AND invite_expires > NOW()`,
        [token]
      );
      if (rows.length === 0) return res.status(400).json({ error: "Invalid or expired invite" });

      const { email, name } = rows[0];

      // Check if Supabase user already exists
      const { data: { users } } = await supabase.auth.admin.listUsers();
      const existing = users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());

      if (existing) {
        // Update password
        const { error: updateError } = await supabase.auth.admin.updateUserById(existing.id, {
          password,
          email_confirm: true,
        });
        if (updateError) return res.status(500).json({ error: `Could not update password: ${updateError.message}` });
      } else {
        // The handle_new_user trigger on auth.users requires a pending team_invitations row.
        // Create a stub invitation row so the trigger succeeds.
        // First ensure we have a team to attach to — use any existing team.
        const { data: teams } = await supabase.from("teams").select("id").limit(1);
        const teamId = teams?.[0]?.id;
        if (!teamId) return res.status(500).json({ error: "No team found in Supabase. Create one first." });

        // Upsert a team_invitations row so the handle_new_user trigger can consume it.
        // Using upsert avoids colliding with a leftover row from a previous flow
        // (the unique constraint is on team_id+email and the trigger doesn't always
        // clean up reliably).
        const { error: inviteErr } = await supabase.from("team_invitations").upsert(
          {
            email: email.toLowerCase(),
            team_id: teamId,
            role: "admin",
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min window
            accepted_at: null,
          },
          { onConflict: "team_id,email" }
        );
        if (inviteErr) return res.status(500).json({ error: `Could not create team invitation: ${inviteErr.message}` });

        // Now create the Supabase user — the trigger will fire and consume the invitation
        const { error: createError } = await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: name || "" },
        });
        if (createError) {
          // Rollback: delete the team_invitations row if user creation failed
          await supabase.from("team_invitations").delete().eq("email", email.toLowerCase()).is("accepted_at", null);
          return res.status(500).json({ error: `Could not create user: ${createError.message}` });
        }
      }

      // Clear invite token so it can't be reused
      await cloudSqlQuery(
        `UPDATE ops_admins SET invite_token = NULL, invite_expires = NULL WHERE id = $1`,
        [rows[0].id]
      );

      res.json({ success: true, email });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Invite a new admin — creates invite token + sends email
  router.post("/invite", requireOpsAdminInline, async (req, res) => {
    const admin = req.admin;

    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
      const { rows: existing } = await cloudSqlQuery(
        `SELECT id FROM ops_admins WHERE LOWER(email) = LOWER($1)`, [email]
      );
      if (existing.length > 0) return res.status(400).json({ error: "This person is already an admin" });

      // Generate custom invite token (not using Supabase since its auth.users is broken)
      const inviteToken = crypto.randomUUID();
      const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      // Add to whitelist with invite token
      const { rows } = await cloudSqlQuery(
        `INSERT INTO ops_admins (email, name, invited_by, invite_token, invite_expires) VALUES (LOWER($1), $2, $3, $4, $5) RETURNING id, email, name`,
        [email, name || null, admin.id, inviteToken, inviteExpires]
      );

      const appUrl = req.headers.origin || req.headers.referer?.replace(/\/$/, "") || "https://linkable-ops.vercel.app";
      const inviteLink = `${appUrl}/accept-invite?token=${inviteToken}`;

      // Send invite email via Resend
      if (process.env.RESEND_API_KEY) {
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          body: JSON.stringify({
            from: "Linkable OPS <noreply@linkable.link>",
            to: email,
            subject: "You've been invited to Linkable OPS",
            html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 0">
              <h2 style="font-size:18px;margin:0 0 8px;color:#0A0A0A">You're in!</h2>
              <p style="color:#525252;font-size:14px;line-height:1.6;margin:0 0 24px">
                ${admin.name || admin.email} invited you to the <strong>Linkable OPS</strong> admin panel. Click the button below to set your password and get started.
              </p>
              <a href="${inviteLink}"
                 style="display:inline-block;padding:12px 28px;background:#0A0A0A;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">
                Set Password & Sign In
              </a>
              <p style="color:#A3A3A3;font-size:11px;margin:24px 0 0">
                This link expires in 7 days. If the button doesn't work, copy: ${inviteLink}
              </p>
            </div>`,
          }),
        }).catch((e) => {
          console.error("Resend error:", e.message);
          return null;
        });
        if (emailRes) {
          const data = await emailRes.json();
          console.log("Invite email sent:", emailRes.status, data?.id || data?.message);
        }
      }

      res.json({ ...rows[0], inviteLink });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all admins. Optional server-side sorting (sortBy/sortDir, allow-listed
  // columns) and per-column contains-filters (filter[name]=…, filter[email]=…).
  // Unknown sort/filter keys are ignored; with no params the original
  // ORDER BY created is preserved and the response shape is unchanged.
  router.get("/admins", requireOpsAdminInline, async (req, res) => {
    const SORTABLE = { name: "name", email: "email", last_login: "last_login" };
    const FILTERABLE = ["name", "email"];

    const sortCol = SORTABLE[req.query.sortBy] || null;
    const sortDir = req.query.sortDir === "desc" ? "DESC" : "ASC";

    // Column-level filters: filter[column_name]=value. Express's extended
    // query parser delivers these as a nested req.query.filter object;
    // parseColumnFilters handles that (and the flat-key form).
    const filters = parseColumnFilters(req.query);

    const conditions = [];
    const params = [];
    for (const col of FILTERABLE) {
      const val = filters[col];
      if (typeof val === "string" && val.trim() !== "") {
        params.push(`%${val.trim()}%`);
        conditions.push(`${col} ILIKE $${params.length}`);
      }
    }

    let sql = `SELECT id, email, name, role, created, last_login FROM ops_admins`;
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += sortCol
      ? ` ORDER BY ${sortCol} ${sortDir} NULLS LAST, created`
      : ` ORDER BY created`;

    try {
      const { rows } = await cloudSqlQuery(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove admin
  router.delete("/admins/:id", requireOpsAdminInline, async (req, res) => {
    if (req.admin.id === req.params.id) return res.status(400).json({ error: "You can't remove yourself" });

    try {
      // Get the target admin
      const { rows } = await cloudSqlQuery(`SELECT email, role FROM ops_admins WHERE id = $1`, [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Admin not found" });

      // Only owners can remove owners
      if (rows[0].role === "owner" && req.admin.role !== "owner") {
        return res.status(403).json({ error: "Only owners can remove other owners" });
      }

      const targetEmail = rows[0].email;

      // Delete from whitelist
      await cloudSqlQuery(`DELETE FROM ops_admins WHERE id = $1`, [req.params.id]);

      // Also delete Supabase auth user (best-effort — look up by email)
      try {
        const { data: { users } } = await supabase.auth.admin.listUsers();
        const supaUser = users?.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase());
        if (supaUser) {
          await supabase.auth.admin.deleteUser(supaUser.id);
        }
      } catch (e) {
        console.error("Failed to delete Supabase user:", e.message);
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// Middleware: verify Supabase token + check ops_admins whitelist
export async function requireOpsAdmin(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });

    const { rows } = await cloudSqlQuery(
      `SELECT id, email, name, role FROM ops_admins WHERE LOWER(email) = LOWER($1)`,
      [user.email]
    );
    if (rows.length === 0) return res.status(403).json({ error: "Not an admin" });

    req.admin = rows[0];
    next();
  } catch {
    res.status(500).json({ error: "Auth check failed" });
  }
}
