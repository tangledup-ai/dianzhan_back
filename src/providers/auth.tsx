import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, getMe, bootstrap as apiBootstrap } from "@/api/auth";
import type { AuthUser } from "@/api/auth";

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  isFullAccess: boolean;
  login: (name: string, password: string) => Promise<void>;
  bootstrap: (name: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  token: null,
  user: null,
  loading: true,
  isFullAccess: false,
  login: async () => {},
  bootstrap: async () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("dsh_token"));
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("dsh_user") || "null");
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(!!localStorage.getItem("dsh_token"));

  // 启动时校验 token 并拉取最新用户
  useEffect(() => {
    if (!localStorage.getItem("dsh_token")) {
      setLoading(false);
      return;
    }
    getMe()
      .then((u) => {
        setUser(u);
        localStorage.setItem("dsh_user", JSON.stringify(u));
      })
      .catch(() => {
        // 401 已由拦截器清空并跳登录
      })
      .finally(() => setLoading(false));
  }, []);

  const applyAuth = (token: string, user: AuthUser) => {
    localStorage.setItem("dsh_token", token);
    localStorage.setItem("dsh_user", JSON.stringify(user));
    setToken(token);
    setUser(user);
  };

  const login = async (name: string, password: string) => {
    const res = await apiLogin(name, password);
    applyAuth(res.token, res.user);
  };

  const bootstrap = async (name: string, password: string) => {
    const res = await apiBootstrap(name, password);
    applyAuth(res.token, res.user);
  };

  const logout = () => {
    localStorage.removeItem("dsh_token");
    localStorage.removeItem("dsh_user");
    setToken(null);
    setUser(null);
  };

  // 老板/财务/财务主管 = 全部权限；股东 = 仅关联场地
  const isFullAccess = user ? ["boss", "finance", "finance_supervisor"].includes(user.role) : true;

  return (
    <AuthContext.Provider value={{ token, user, loading, isFullAccess, login, bootstrap, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
