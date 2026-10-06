import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, onUnauthorized, setToken } from "@/api/client";

// Phase 1 auth: one shared workspace access code → token. Phase 4 replaces this with real users.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [workspace, setWorkspace] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!getToken()) {
      // The httpOnly cookie may still be valid; ask once.
      api.auth.me()
        .then((r) => !cancelled && setWorkspace(r.workspace))
        .catch(() => {})
        .finally(() => !cancelled && setChecking(false));
    } else {
      api.auth.me()
        .then((r) => !cancelled && setWorkspace(r.workspace))
        .catch(() => setToken(null))
        .finally(() => !cancelled && setChecking(false));
    }
    const off = onUnauthorized(() => {
      setToken(null);
      setWorkspace(null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const login = useCallback(async (code) => {
    const { token, workspace: ws } = await api.auth.login(code);
    setToken(token);
    setWorkspace(ws);
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => {});
    setToken(null);
    setWorkspace(null);
  }, []);

  const replaceToken = useCallback((token) => setToken(token), []);

  return (
    <AuthContext.Provider value={{ workspace, checking, login, logout, replaceToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
