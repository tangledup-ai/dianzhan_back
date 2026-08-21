import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/providers/auth";
import { BatteryCharging } from "lucide-react";
import { toast } from "sonner";

export default function Login() {
  const { login, bootstrap } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!name.trim() || !password) { toast.error("请输入姓名和密码"); return; }
    if (mode === "bootstrap" && password !== confirm) { toast.error("两次密码不一致"); return; }
    setLoading(true);
    try {
      if (mode === "login") {
        await login(name.trim(), password);
      } else {
        await bootstrap(name.trim(), password);
      }
      toast.success("登录成功");
      navigate("/");
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message || "操作失败";
      toast.error(msg);
      if (mode === "bootstrap" && msg.includes("已有平台用户")) {
        setMode("login");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100">
      <div className="w-[380px] rounded-2xl border bg-white p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500 text-white">
            <BatteryCharging className="h-6 w-6" />
          </div>
          <h1 className="mt-3 text-lg font-bold text-slate-800">换电站经营管理平台</h1>
          <p className="mt-1 text-xs text-slate-400">
            {mode === "login" ? "请使用平台账号登录" : "首次使用：创建管理员（老板）账号"}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">姓名</label>
            <input
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入姓名"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">密码</label>
            <input
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          {mode === "bootstrap" && (
            <div>
              <label className="mb-1 block text-xs text-slate-500">确认密码</label>
              <input
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-emerald-400 focus:outline-none"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再次输入密码"
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </div>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full rounded-md bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {loading ? "请稍候…" : mode === "login" ? "登 录" : "创建并登录"}
          </button>

          <button
            onClick={() => setMode(mode === "login" ? "bootstrap" : "login")}
            className="w-full text-center text-xs text-slate-400 hover:text-emerald-600"
          >
            {mode === "login" ? "首次使用？创建管理员账号" : "已有账号？返回登录"}
          </button>
        </div>
      </div>
    </div>
  );
}
