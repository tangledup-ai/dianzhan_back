import { Routes, Route, Navigate } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import Layout from "@/components/Layout";
import { AuthProvider, useAuth } from "@/providers/auth";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Stations from "@/pages/Stations";
import Electricity from "@/pages/Electricity";
import Rent from "@/pages/Rent";
import Brands from "@/pages/Brands";
import Entities from "@/pages/Entities";
import Landlords from "@/pages/Landlords";
import Shareholders from "@/pages/Shareholders";
import Contracts from "@/pages/Contracts";
import Approvals from "@/pages/Approvals";
import Meters from "@/pages/Meters";
import Directory from "@/pages/Directory";
import Alerts from "@/pages/Alerts";

// 登录守卫：未登录跳转 /login
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <div className="text-sm text-slate-400">加载中…</div>
      </div>
    );
  }
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { token, user } = useAuth();
  const isShareholder = user?.role === "shareholder";
  return (
    <Routes>
      <Route path="/login" element={token ? <Navigate to={isShareholder ? "/shareholders" : "/"} replace /> : <Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        {/* 股东不能查看「经营总览」，访问 / 自动跳转股东分红 */}
        <Route path="/" element={isShareholder ? <Navigate to="/shareholders" replace /> : <Dashboard />} />
        {/* 股东访问被隐藏页面（直接输 URL 也拦截）→ 跳转股东分红 */}
        {isShareholder && (["/brands", "/entities", "/landlords", "/approvals", "/directory", "/alerts"] as const).map((p) => (
          <Route key={p} path={p} element={<Navigate to="/shareholders" replace />} />
        ))}
        <Route path="/stations" element={<Stations />} />
        <Route path="/electricity" element={<Electricity />} />
        <Route path="/rent" element={<Rent />} />
        <Route path="/brands" element={<Brands />} />
        <Route path="/entities" element={<Entities />} />
        <Route path="/landlords" element={<Landlords />} />
        <Route path="/shareholders" element={<Shareholders />} />
        <Route path="/contracts" element={<Contracts />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/meters" element={<Meters />} />
        <Route path="/directory" element={<Directory />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="*" element={<Navigate to={isShareholder ? "/shareholders" : "/"} replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Toaster richColors position="top-center" />
      <AppRoutes />
    </AuthProvider>
  );
}
