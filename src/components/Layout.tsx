import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  LayoutDashboard, Building2, Zap, Home as HomeIcon, Tag, Landmark,
  MapPin, Users, FileText, Gauge, FolderCog, BatteryCharging, FileCheck2, LogOut, AlertTriangle, Settings as SettingsIcon,
} from "lucide-react";
import { useAuth } from "@/providers/auth";

const NAV = [
  { to: "/", label: "经营总览", icon: LayoutDashboard, end: true },
  { to: "/stations", label: "场地数据", icon: Building2 },
  { to: "/electricity", label: "电费台账", icon: Zap },
  { to: "/rent", label: "场租台账", icon: HomeIcon },
  { to: "/brands", label: "品牌方", icon: Tag },
  { to: "/entities", label: "公司主体", icon: Landmark },
  { to: "/landlords", label: "场地方", icon: MapPin },
  { to: "/shareholders", label: "股东分红", icon: Users },
  { to: "/contracts", label: "合同管理", icon: FileText },
  { to: "/approvals", label: "审批中心", icon: FileCheck2 },
  { to: "/meters", label: "智慧电表", icon: Gauge },
  { to: "/alerts", label: "异常预警", icon: AlertTriangle },
  { to: "/directory", label: "基础档案", icon: FolderCog },
  { to: "/settings", label: "系统设置", icon: SettingsIcon },
];

// 股东账号隐藏：经营总览/品牌方/公司主体/场地方/审批中心/基础档案/异常预警/系统设置（无关或涉全局）
const SHAREHOLDER_HIDDEN = new Set(["/", "/brands", "/entities", "/landlords", "/approvals", "/directory", "/alerts", "/settings"]);

const ROLE_LABEL: Record<string, string> = {
  boss: "老板",
  finance: "财务",
  finance_supervisor: "财务主管",
  shareholder: "股东",
};

const TITLES: Record<string, string> = {
  "/": "经营总览", "/stations": "场地数据", "/electricity": "电费台账", "/rent": "场租台账",
  "/brands": "品牌方看板", "/entities": "公司主体看板", "/landlords": "场地方（业主）看板",
  "/shareholders": "股东分红", "/contracts": "合同管理", "/approvals": "审批中心",
  "/meters": "智慧电表", "/directory": "基础档案", "/alerts": "异常预警", "/settings": "系统设置",
};

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const title = TITLES[location.pathname] ?? "换电站经营管理平台";
  const isShareholder = user?.role === "shareholder";
  const nav = isShareholder ? NAV.filter((n) => !SHAREHOLDER_HIDDEN.has(n.to)) : NAV;

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col bg-slate-900 text-slate-300">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-white">
            <BatteryCharging className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">换电站经营管理平台</div>
            <div className="text-[11px] text-slate-400">收支 · 盈利 · 分红一体化</div>
          </div>
        </div>
        <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  isActive ? "bg-emerald-500/15 font-medium text-emerald-400" : "hover:bg-slate-800 hover:text-white"
                }`
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-4 text-[11px] text-slate-500">内部管理专用 · 数据实时保存</div>
      </aside>
      <div className="ml-56 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-white px-6">
          <h1 className="text-base font-semibold text-slate-800">{title}</h1>
          <div className="flex items-center gap-3">
            {user && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700">{user.name}</span>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  {ROLE_LABEL[user.role] ?? user.role}
                </span>
                {isShareholder && user.landlordIds?.length > 0 && (
                  <span className="text-[10px] text-slate-400">关联 {user.landlordIds.length} 个场地</span>
                )}
                {user.meterTagScope && (
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700" title="该账号仅可查看此类电表相关的数据">
                    仅{user.meterTagScope}
                  </span>
                )}
              </div>
            )}
            <button
              onClick={() => { logout(); navigate("/login"); }}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
              title="退出登录"
            >
              <LogOut className="h-3.5 w-3.5" />
              退出
            </button>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
