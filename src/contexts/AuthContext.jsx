import { createContext, useContext, useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  // Distinct from accessDenied: a session exists and is valid, but the admin
  // check itself failed (a 500, a network error) rather than saying no. That
  // used to fall through to "admin: null" same as a bad login, which sent a
  // signed-in person back to the login screen with nothing telling them the
  // server — not their password — was the problem.
  const [authError, setAuthError] = useState("");

  // Check if Supabase user is a whitelisted admin
  async function checkAdmin(accessToken) {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        setAdmin(await res.json());
        setAccessDenied(false);
        setAuthError("");
      } else if (res.status === 403) {
        setAdmin(null);
        setAccessDenied(true);
        setAuthError("");
      } else {
        setAdmin(null);
        const body = await res.json().catch(() => null);
        setAuthError(body?.error || `The server returned ${res.status} while checking your access.`);
      }
    } catch (e) {
      setAdmin(null);
      setAuthError(e.message || "Could not reach the server.");
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      if (s?.access_token) {
        checkAdmin(s.access_token).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s?.access_token) {
        checkAdmin(s.access_token);
      } else {
        setAdmin(null);
        setAccessDenied(false);
        setAuthError("");
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  };

  const signUp = async (email, password, name) => {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: name } },
    });
    if (error) throw error;
    return data;
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setAdmin(null);
    setAccessDenied(false);
    setAuthError("");
  };

  // Re-runs the admin check against the current session — what "Try Again"
  // on the error screen does, without a full page reload.
  const retryAuth = async () => {
    const { data: { session: s } } = await supabase.auth.getSession();
    if (s?.access_token) await checkAdmin(s.access_token);
  };

  // Get the current access token for API calls (always fresh)
  const getToken = async () => {
    const { data: { session: s } } = await supabase.auth.getSession();
    return s?.access_token || null;
  };

  return (
    <AuthContext.Provider value={{ session, admin, loading, accessDenied, authError, login, signUp, logout, getToken, retryAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
