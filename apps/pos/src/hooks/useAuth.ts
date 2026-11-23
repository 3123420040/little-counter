import { createContext, useContext, useState, useCallback, useEffect, createElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, setToken, getToken, SCOPE_CHANGED_EVENT, type LoginResponse } from "../api/client";
import { completeRequiredPasswordChange as completeRequiredPasswordChangeRequest } from "../api/settings-endpoints";
import { clearOfflineState } from "../utils/offlineQueue";

interface Operator {
  id: string;
  role: string;
  displayName: string;
  organizationId: string;
}

interface AuthState {
  isAuthenticated: boolean;
  requiresPasswordChange: boolean;
  operator: Operator | null;
  login: (operatorId: string, password: string) => Promise<void>;
  completeRequiredPasswordChange: (newPassword: string) => Promise<void>;
  logout: () => void;
  sessionExpired: boolean;
  acknowledgeSessionExpired: () => void;
}

const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  requiresPasswordChange: false,
  operator: null,
  login: async () => {},
  completeRequiredPasswordChange: async () => {},
  logout: () => {},
  sessionExpired: false,
  acknowledgeSessionExpired: () => {},
});

function clearScopeSession() {
  sessionStorage.removeItem("snus_operating_store_id");
  sessionStorage.removeItem("snus_operating_merchant_id");
  sessionStorage.removeItem("snus_report_store_ids");
  sessionStorage.removeItem("snus_report_merchant_id");
  window.dispatchEvent(new CustomEvent(SCOPE_CHANGED_EVENT));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [operator, setOperatorState] = useState<Operator | null>(() => {
    try {
      localStorage.removeItem("snus_operator");
      localStorage.removeItem("snus_auth_state");
      const saved = sessionStorage.getItem("snus_operator");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [requiresPasswordChange, setRequiresPasswordChange] = useState(() => (
    sessionStorage.getItem("snus_auth_state") === "password_change_required"
  ));
  const [sessionExpired, setSessionExpired] = useState(false);

  const clearLocalSession = useCallback(() => {
    setToken(null);
    setOperatorState(null);
    setRequiresPasswordChange(false);
    sessionStorage.removeItem("snus_operator");
    sessionStorage.removeItem("snus_auth_state");
    localStorage.removeItem("snus_operator");
    localStorage.removeItem("snus_auth_state");
    clearScopeSession();
    queryClient.clear();
    void clearOfflineState();
  }, [queryClient]);

  const login = useCallback(async (operatorId: string, password: string) => {
    const res = await api.post<LoginResponse>("/api/pos/login", { operatorId, password });
    queryClient.clear();
    await clearOfflineState();
    clearScopeSession();
    setToken(res.data.token);
    setOperatorState(res.data.operator);
    const restricted = res.data.authState === "password_change_required" || Boolean(res.data.security?.requiresPasswordChange);
    setRequiresPasswordChange(restricted);
    sessionStorage.setItem("snus_operator", JSON.stringify(res.data.operator));
    sessionStorage.setItem("snus_auth_state", restricted ? "password_change_required" : "authenticated");
    setSessionExpired(false);
  }, [queryClient]);

  const completeRequiredPasswordChange = useCallback(async (newPassword: string) => {
    const res = await completeRequiredPasswordChangeRequest({ newPassword });
    setToken(res.data.token);
    setRequiresPasswordChange(false);
    sessionStorage.setItem("snus_auth_state", "authenticated");
    queryClient.clear();
    await clearOfflineState();
    setSessionExpired(false);
  }, [queryClient]);

  const logout = useCallback(() => {
    sessionStorage.removeItem("snus_return_to");
    clearLocalSession();
    setSessionExpired(false);
  }, [clearLocalSession]);

  const acknowledgeSessionExpired = useCallback(() => setSessionExpired(false), []);

  useEffect(() => {
    const handleUnauthorized = () => {
      const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (path.startsWith("/") && !path.startsWith("//") && path !== "/") {
        sessionStorage.setItem("snus_return_to", path);
      }
      clearLocalSession();
      setSessionExpired(true);
    };
    window.addEventListener("snus:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("snus:unauthorized", handleUnauthorized);
  }, [clearLocalSession]);

  const isAuthenticated = !!(getToken() && operator);

  return createElement(
    AuthContext.Provider,
    { value: { isAuthenticated, requiresPasswordChange, operator, login, completeRequiredPasswordChange, logout, sessionExpired, acknowledgeSessionExpired } as AuthState },
    children,
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
