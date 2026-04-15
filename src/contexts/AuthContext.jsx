import { createContext, useContext, useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);

  // Check if Supabase user is a whitelisted admin
  async function checkAdmin(accessToken) {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        setAdmin(await res.json());
        setAccessDenied(false);
      } else if (res.status === 403) {
        setAdmin(null);
        setAccessDenied(true);
      } else {
        setAdmin(null);
      }
    } catch {
      setAdmin(null);
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
  };

  // Get the current access token for API calls (always fresh)
  const getToken = async () => {
    const { data: { session: s } } = await supabase.auth.getSession();
    return s?.access_token || null;
  };

  return (
    <AuthContext.Provider value={{ session, admin, loading, accessDenied, login, signUp, logout, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
