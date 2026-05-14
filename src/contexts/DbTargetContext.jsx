import { createContext, useContext, useState, useCallback } from "react";

// "prod" or "dev". Persisted to localStorage so the toggle survives reloads.
// The api request layer reads `getDbTarget()` synchronously to add the
// x-db-target header on every fetch — keeping the source-of-truth in
// localStorage avoids a stale-closure race when navigating quickly after
// flipping the toggle.
const STORAGE_KEY = "linkable-db-target";

function readTarget() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dev" ? "dev" : "prod";
  } catch {
    return "prod";
  }
}

export function getDbTarget() {
  return readTarget();
}

const DbTargetContext = createContext(null);

export function DbTargetProvider({ children }) {
  const [target, setTargetState] = useState(readTarget);

  const setTarget = useCallback((next) => {
    const v = next === "dev" ? "dev" : "prod";
    try { localStorage.setItem(STORAGE_KEY, v); } catch {}
    setTargetState(v);
  }, []);

  return (
    <DbTargetContext.Provider value={{ target, setTarget }}>
      {children}
    </DbTargetContext.Provider>
  );
}

export function useDbTarget() {
  const ctx = useContext(DbTargetContext);
  if (!ctx) throw new Error("useDbTarget must be used within DbTargetProvider");
  return ctx;
}
