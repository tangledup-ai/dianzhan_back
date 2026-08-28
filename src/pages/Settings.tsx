import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { KeyRound, MapPin, Bot } from "lucide-react";
import { toast } from "sonner";
import { fetchSystemConfig, updateSystemConfig, type SystemConfig } from "@/api/systemConfig";

export default function Settings() {
  const [config, setConfig] = useState<SystemConfig>({ deepseekApiKey: "", mapKey: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSystemConfig()
      .then(setConfig)
      .catch(() => toast.error("加载系统配置失败"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSystemConfig(config);
      toast.success("保存成功，配置已生效");
    } catch {
      toast.error("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-slate-400">加载中…</div>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-emerald-600" />
            第三方服务密钥
          </CardTitle>
          <CardDescription>
            在此填写各服务的 API Key；不填写时使用内置默认值。保存后立即生效，无需重启服务。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <Bot className="h-4 w-4 text-slate-400" />
              DeepSeek API Key
              <span className="text-xs font-normal text-slate-400">（小程序 AI 对话）</span>
            </label>
            <Input
              type="password"
              placeholder="sk-..."
              value={config.deepseekApiKey}
              onChange={(e) => setConfig((c) => ({ ...c, deepseekApiKey: e.target.value }))}
            />
            <p className="text-xs text-slate-400">
              在 DeepSeek 开放平台 platform.deepseek.com 创建，用于小程序端 AI 经营助手对话。
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <MapPin className="h-4 w-4 text-slate-400" />
              腾讯地图 Key
              <span className="text-xs font-normal text-slate-400">（地图组件）</span>
            </label>
            <Input
              placeholder="如 VS3BZ-XXXX-XXXX-XXXX-XXXX-XXXX"
              value={config.mapKey}
              onChange={(e) => setConfig((c) => ({ ...c, mapKey: e.target.value }))}
            />
            <p className="text-xs text-slate-400">
              在腾讯位置服务 lbs.qq.com 申请 WebService API key，用于站点地图展示与选点。
            </p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
