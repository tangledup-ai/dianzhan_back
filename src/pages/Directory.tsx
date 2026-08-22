import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listBrands, createBrand, updateBrand, deleteBrand,
  listEntities, createEntity, updateEntity, deleteEntity,
  listLandlords, createLandlord, updateLandlord, deleteLandlord,
  listShareholders, createShareholder, updateShareholder, deleteShareholder,
  listIntroducers, createIntroducer, updateIntroducer, deleteIntroducer,
  listPlatformUsers, createPlatformUser, updatePlatformUser, deletePlatformUser,
  listThirdPartyConfigs, createThirdPartyConfig, updateThirdPartyConfig, deleteThirdPartyConfig,
  testThirdPartyConfig,
} from "@/api/directory";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/fields";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { exportXlsx } from "@/lib/export";
import { getAlertConfig, saveAlertConfig } from "@/api/alerts";
import { Plus, Pencil, Trash2, Check, X, Search, Download, PlugZap, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

type RowDef = { key: string; label: string; placeholder?: string }[];

function CrudTable(props: {
  title: string;
  columns: RowDef;
  rows: any[] | undefined;
  onCreate: (v: Record<string, string | null>) => Promise<any>;
  onUpdate: (id: number, v: Record<string, string | null>) => Promise<any>;
  onDelete: (id: number) => Promise<any>;
}) {
  const queryClient = useQueryClient();
  const blank = Object.fromEntries(props.columns.map((c) => [c.key, ""]));
  const [draft, setDraft] = useState(blank);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState(blank);
  const [keyword, setKeyword] = useState("");

  const invalidate = () => queryClient.invalidateQueries();

  const filteredRows = useMemo(() => {
    if (!keyword || !props.rows) return props.rows ?? [];
    return props.rows.filter((r: any) =>
      props.columns.some((c) => String(r[c.key] ?? "").includes(keyword))
    );
  }, [props.rows, keyword, props.columns]);

  const create = async () => {
    if (!draft[props.columns[0].key]?.trim()) { toast.error(`请填写${props.columns[0].label}`); return; }
    try {
      await props.onCreate(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, (v as string).trim() || null])));
      setDraft(blank);
      toast.success("已保存");
      invalidate();
    } catch (e: any) { toast.error(e.message); }
  };
  const startEdit = (row: any) => {
    setEditId(row.id);
    setEditDraft(Object.fromEntries(props.columns.map((c) => [c.key, String(row[c.key] ?? "")])));
  };
  const saveEdit = async () => {
    if (editId === null) return;
    try {
      await props.onUpdate(editId, Object.fromEntries(Object.entries(editDraft).map(([k, v]) => [k, (v as string).trim() || null])));
      setEditId(null);
      toast.success("已保存");
      invalidate();
    } catch (e: any) { toast.error(e.message); }
  };

  const doExport = () => {
    if (!filteredRows.length) { toast.error("暂无数据可导出"); return; }
    exportXlsx(`${props.title}_${new Date().toISOString().slice(0, 10)}`, [{
      name: props.title,
      rows: filteredRows.map((r: any) => {
        const row: Record<string, any> = {};
        props.columns.forEach((c) => { row[c.label] = r[c.key] ?? ""; });
        return row;
      }),
    }]);
    toast.success("已导出 Excel");
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">{props.title}（{filteredRows.length}）</span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
            <input className={`${inputCls} w-40 pl-7 text-xs`} placeholder="搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={doExport}><Download className="mr-1 h-3 w-3" />导出</Button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b bg-slate-50 text-left text-xs text-slate-500">
          {props.columns.map((c) => <th key={c.key} className="px-4 py-2.5 font-medium">{c.label}</th>)}
          <th className="px-4 py-2.5 text-center font-medium">操作</th>
        </tr></thead>
        <tbody>
          <tr className="border-b bg-emerald-50/40">
            {props.columns.map((c) => (
              <td key={c.key} className="px-3 py-2">
                <input className={`${inputCls} w-full`} placeholder={c.placeholder ?? c.label} value={draft[c.key] as string}
                  onChange={(e) => setDraft((p) => ({ ...p, [c.key]: e.target.value }))} />
              </td>
            ))}
            <td className="px-3 py-2 text-center">
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={create}><Plus className="mr-1 h-3.5 w-3.5" />添加</Button>
            </td>
          </tr>
          {filteredRows.map((row: any) => (
            <tr key={row.id} className="border-b last:border-0 hover:bg-slate-50/60">
              {props.columns.map((c) => (
                <td key={c.key} className="px-4 py-2.5">
                  {editId === row.id ? (
                    <input className={`${inputCls} w-full`} value={editDraft[c.key] as string}
                      onChange={(e) => setEditDraft((p) => ({ ...p, [c.key]: e.target.value }))} />
                  ) : (
                    <span className={c.key === props.columns[0].key ? "font-medium" : "text-slate-600"}>{String(row[c.key] ?? "-")}</span>
                  )}
                </td>
              ))}
              <td className="px-4 py-2.5">
                <div className="flex justify-center gap-1">
                  {editId === row.id ? (
                    <>
                      <button className="rounded p-1 text-emerald-600 hover:bg-emerald-50" onClick={saveEdit}><Check className="h-4 w-4" /></button>
                      <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={() => setEditId(null)}><X className="h-4 w-4" /></button>
                    </>
                  ) : (
                    <>
                      <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={() => startEdit(row)}><Pencil className="h-4 w-4" /></button>
                      <button className="rounded p-1 text-slate-400 hover:text-rose-500"
                        onClick={() => window.confirm("删除该档案？") && props.onDelete(row.id).then(() => { toast.success("已删除"); invalidate(); })}><Trash2 className="h-4 w-4" /></button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 站点管理 ───
const ROLE_OPTIONS = [
  { value: "boss", label: "老板" },
  { value: "finance", label: "财务" },
  { value: "finance_supervisor", label: "财务主管" },
  { value: "shareholder", label: "股东" },
];

const roleLabel = (role: string) => ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;

function PlatformUsersTable({ shareholders, landlords }: { shareholders: any[] | undefined; landlords: any[] | undefined }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["platformUsers"], queryFn: listPlatformUsers });
  const [draft, setDraft] = useState({ name: "", role: "boss", shareholderId: "", password: "", landlordIds: [] as number[], phone: "", remark: "" });
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ name: "", role: "boss", shareholderId: "", password: "", landlordIds: [] as number[], phone: "", remark: "" });
  const [keyword, setKeyword] = useState("");

  const invalidate = () => queryClient.invalidateQueries();

  const filteredRows = useMemo(() => {
    if (!keyword || !users.data) return users.data ?? [];
    return users.data.filter((r: any) =>
      r.name?.includes(keyword) || roleLabel(r.role).includes(keyword) || r.shareholderName?.includes(keyword) || r.phone?.includes(keyword)
    );
  }, [users.data, keyword]);

  const toPayload = (d: typeof draft) => ({
    name: d.name.trim(),
    role: d.role,
    shareholderId: d.role === "shareholder" && d.shareholderId ? Number(d.shareholderId) : null,
    // 密码：留空则不改（创建时留空 = 无法登录）
    password: d.password.trim() || undefined,
    // 股东关联场地：非股东清空
    landlordIds: d.role === "shareholder" ? d.landlordIds : [],
    phone: d.phone.trim() || null,
    remark: d.remark.trim() || null,
  });

  const create = async () => {
    if (!draft.name.trim()) { toast.error("请填写姓名"); return; }
    if (draft.role === "shareholder" && !draft.shareholderId) { toast.error("请选择关联的股东"); return; }
    try {
      await createPlatformUser(toPayload(draft));
      setDraft({ name: "", role: "boss", shareholderId: "", password: "", landlordIds: [], phone: "", remark: "" });
      toast.success("已保存");
      invalidate();
    } catch (e: any) { toast.error(e.message); }
  };

  const startEdit = (row: any) => {
    setEditId(row.id);
    setEditDraft({
      name: row.name ?? "",
      role: row.role ?? "boss",
      shareholderId: row.shareholderId ? String(row.shareholderId) : "",
      password: "",
      landlordIds: (row.landlordIds ?? []).map(Number),
      phone: row.phone ?? "",
      remark: row.remark ?? "",
    });
  };

  const saveEdit = async () => {
    if (editId === null) return;
    try {
      await updatePlatformUser(editId, toPayload(editDraft));
      setEditId(null);
      toast.success("已保存");
      invalidate();
    } catch (e: any) { toast.error(e.message); }
  };

  const doExport = () => {
    if (!filteredRows.length) { toast.error("暂无数据可导出"); return; }
    exportXlsx(`平台使用人员_${new Date().toISOString().slice(0, 10)}`, [{
      name: "平台使用人员",
      rows: filteredRows.map((r: any) => ({
        姓名: r.name,
        角色: roleLabel(r.role),
        关联股东: r.shareholderName ?? "-",
        电话: r.phone ?? "-",
        备注: r.remark ?? "-",
      })),
    }]);
    toast.success("已导出 Excel");
  };

  const renderRow = (d: typeof draft, setD: any) => (
    <>
      <td className="px-3 py-2">
        <input className={`${inputCls} w-24`} placeholder="姓名" value={d.name}
          onChange={(e) => setD((p: any) => ({ ...p, name: e.target.value }))} />
      </td>
      <td className="px-3 py-2">
        <select className={`${inputCls} w-28`} value={d.role}
          onChange={(e) => setD((p: any) => ({ ...p, role: e.target.value, shareholderId: "" }))}>
          {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td className="px-3 py-2">
        {d.role === "shareholder" ? (
          <select className={`${inputCls} w-28`} value={d.shareholderId}
            onChange={(e) => setD((p: any) => ({ ...p, shareholderId: e.target.value }))}>
            <option value="">选择股东…</option>
            {(shareholders ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : (
          <span className="text-xs text-slate-400">-</span>
        )}
      </td>
      <td className="px-3 py-2">
        {d.role === "shareholder" ? (
          <select multiple size={3} className={`${inputCls} w-36 text-xs`}
            value={d.landlordIds.map(String)}
            onChange={(e) => setD((p: any) => ({ ...p, landlordIds: Array.from(e.target.selectedOptions).map((o: any) => Number(o.value)) }))}>
            {(landlords ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : (
          <span className="text-xs text-slate-400">-</span>
        )}
      </td>
      <td className="px-3 py-2">
        <input type="password" className={`${inputCls} w-24`} placeholder="登录密码"
          value={d.password} onChange={(e) => setD((p: any) => ({ ...p, password: e.target.value }))} />
      </td>
      <td className="px-3 py-2">
        <input className={`${inputCls} w-28`} placeholder="电话" value={d.phone}
          onChange={(e) => setD((p: any) => ({ ...p, phone: e.target.value }))} />
      </td>
      <td className="px-3 py-2">
        <input className={`${inputCls} w-32`} placeholder="备注" value={d.remark}
          onChange={(e) => setD((p: any) => ({ ...p, remark: e.target.value }))} />
      </td>
    </>
  );

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">平台使用人员（{filteredRows.length}）</span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
            <input className={`${inputCls} w-40 pl-7 text-xs`} placeholder="搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={doExport}><Download className="mr-1 h-3 w-3" />导出</Button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b bg-slate-50 text-left text-xs text-slate-500">
          <th className="px-4 py-2.5 font-medium">姓名</th>
          <th className="px-4 py-2.5 font-medium">角色</th>
          <th className="px-4 py-2.5 font-medium">关联股东</th>
          <th className="px-4 py-2.5 font-medium">关联场地</th>
          <th className="px-4 py-2.5 font-medium">密码</th>
          <th className="px-4 py-2.5 font-medium">电话</th>
          <th className="px-4 py-2.5 font-medium">备注</th>
          <th className="px-4 py-2.5 text-center font-medium">操作</th>
        </tr></thead>
        <tbody>
          <tr className="border-b bg-emerald-50/40">
            {renderRow(draft, setDraft)}
            <td className="px-3 py-2 text-center">
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={create}><Plus className="mr-1 h-3.5 w-3.5" />添加</Button>
            </td>
          </tr>
          {filteredRows.map((row: any) => (
            <tr key={row.id} className="border-b last:border-0 hover:bg-slate-50/60">
              {editId === row.id ? (
                <>
                  {renderRow(editDraft, setEditDraft)}
                  <td className="px-4 py-2.5">
                    <div className="flex justify-center gap-1">
                      <button className="rounded p-1 text-emerald-600 hover:bg-emerald-50" onClick={saveEdit}><Check className="h-4 w-4" /></button>
                      <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={() => setEditId(null)}><X className="h-4 w-4" /></button>
                    </div>
                  </td>
                </>
              ) : (
                <>
                  <td className="px-4 py-2.5 font-medium">{row.name}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                      row.role === "boss" ? "bg-amber-100 text-amber-700" :
                      row.role === "shareholder" ? "bg-blue-100 text-blue-700" :
                      "bg-emerald-100 text-emerald-700"
                    }`}>{roleLabel(row.role)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{row.shareholderName ?? "-"}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {row.role === "shareholder" && (row.landlordIds ?? []).length > 0
                      ? (landlords ?? []).filter((l: any) => (row.landlordIds ?? []).includes(l.id)).map((l: any) => l.name).join("、") || "-"
                      : "-"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{row.phone ?? "-"}</td>
                  <td className="px-4 py-2.5 text-slate-600">{row.remark ?? "-"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-center gap-1">
                      <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={() => startEdit(row)}><Pencil className="h-4 w-4" /></button>
                      <button className="rounded p-1 text-slate-400 hover:text-rose-500"
                        onClick={() => window.confirm("删除该人员？") && deletePlatformUser(row.id).then(() => { toast.success("已删除"); invalidate(); })}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const METER_TAG_OPTIONS = [
  { value: "合作商电表", label: "合作商电表" },
  { value: "民用电表", label: "民用电表" },
  { value: "共享电表", label: "共享电表" },
];

const tagColor = (tag: string) =>
  tag === "民用电表" ? "bg-amber-100 text-amber-700" :
  tag === "共享电表" ? "bg-purple-100 text-purple-700" :
  "bg-blue-100 text-blue-700";

// ─── 第三方接口配置 ───
function ThirdPartyConfigsTable() {
  const queryClient = useQueryClient();
  const configs = useQuery({ queryKey: ["thirdPartyConfigs"], queryFn: listThirdPartyConfigs });
  const [draft, setDraft] = useState({ name: "", baseUrl: "", authCode: "", meterTag: "合作商电表", remark: "" });
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ name: "", baseUrl: "", authCode: "", meterTag: "合作商电表", remark: "" });
  const [keyword, setKeyword] = useState("");
  const [testingId, setTestingId] = useState<number | "draft" | null>(null);

  const invalidate = () => queryClient.invalidateQueries();

  const filteredRows = useMemo(() => {
    if (!keyword || !configs.data) return configs.data ?? [];
    return configs.data.filter((r: any) =>
      r.name?.includes(keyword) || r.baseUrl?.includes(keyword) || r.meterTag?.includes(keyword)
    );
  }, [configs.data, keyword]);

  const toPayload = (d: typeof draft) => ({
    name: d.name.trim(),
    baseUrl: d.baseUrl.trim(),
    authCode: d.authCode.trim(),
    meterTag: d.meterTag,
    remark: d.remark.trim() || null,
  });

  const create = async () => {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.authCode.trim()) { toast.error("请填写名称、接口地址和授权码"); return; }
    try {
      await createThirdPartyConfig(toPayload(draft));
      setDraft({ name: "", baseUrl: "", authCode: "", meterTag: "合作商电表", remark: "" });
      toast.success("已保存");
      invalidate();
    } catch (e: any) { toast.error(e.message); }
  };

  const startEdit = (row: any) => {
    setEditId(row.id);
    setEditDraft({
      name: row.name ?? "",
      baseUrl: row.baseUrl ?? "",
      authCode: row.authCode ?? "",
      meterTag: row.meterTag ?? "合作商电表",
      remark: row.remark ?? "",
    });
  };

  const saveEdit = async () => {
    if (editId === null) return;
    try {
      await updateThirdPartyConfig(editId, toPayload(editDraft));
      setEditId(null);
      toast.success("已保存");
      invalidate();
    } catch (e: any) { toast.error(e.message); }
  };

  const doTest = async (payload: { baseUrl: string; authCode: string }, id: number | "draft") => {
    if (!payload.baseUrl || !payload.authCode) { toast.error("请填写接口地址和授权码"); return; }
    setTestingId(id);
    try {
      const res = await testThirdPartyConfig(payload);
      toast.success(res.message ?? "连接成功");
    } catch (e: any) {
      toast.error(e.message || "连接失败");
    } finally {
      setTestingId(null);
    }
  };

  const renderRow = (d: typeof draft, setD: any) => (
    <>
      <td className="px-3 py-2">
        <input className={`${inputCls} w-32`} placeholder="账户名称" value={d.name}
          onChange={(e) => setD((p: any) => ({ ...p, name: e.target.value }))} />
      </td>
      <td className="px-3 py-2">
        <input className={`${inputCls} w-56`} placeholder="https://api1.tqdianbiao.com" value={d.baseUrl}
          onChange={(e) => setD((p: any) => ({ ...p, baseUrl: e.target.value }))} />
      </td>
      <td className="px-3 py-2">
        <input className={`${inputCls} w-56`} placeholder="授权码" value={d.authCode}
          onChange={(e) => setD((p: any) => ({ ...p, authCode: e.target.value }))} />
      </td>
      <td className="px-3 py-2">
        <select className={`${inputCls} w-32`} value={d.meterTag}
          onChange={(e) => setD((p: any) => ({ ...p, meterTag: e.target.value }))}>
          {METER_TAG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </td>
      <td className="px-3 py-2">
        <input className={`${inputCls} w-32`} placeholder="备注" value={d.remark}
          onChange={(e) => setD((p: any) => ({ ...p, remark: e.target.value }))} />
      </td>
    </>
  );

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">第三方接口配置（{filteredRows.length}）</span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
            <input className={`${inputCls} w-40 pl-7 text-xs`} placeholder="搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="px-4 py-2 text-xs text-slate-500">
        meters 页面从这些账户自动拉取电表基础信息；导入的电表自动带上该账户的「电表类型」标签。不同账户可配不同的接口地址 / 授权码 / 电表类型。
      </div>
      <table className="w-full text-sm">
        <thead><tr className="border-b bg-slate-50 text-left text-xs text-slate-500">
          <th className="px-4 py-2.5 font-medium">账户名称</th>
          <th className="px-4 py-2.5 font-medium">接口地址</th>
          <th className="px-4 py-2.5 font-medium">授权码</th>
          <th className="px-4 py-2.5 font-medium">电表类型</th>
          <th className="px-4 py-2.5 font-medium">备注</th>
          <th className="px-4 py-2.5 text-center font-medium">操作</th>
        </tr></thead>
        <tbody>
          <tr className="border-b bg-emerald-50/40">
            {renderRow(draft, setDraft)}
            <td className="px-3 py-2 text-center">
              <div className="flex justify-center gap-1">
                <Button size="sm" variant="outline" onClick={() => doTest(toPayload(draft), "draft")} disabled={testingId === "draft"}>
                  <PlugZap className="mr-1 h-3 w-3" />{testingId === "draft" ? "测试中…" : "测试"}
                </Button>
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={create}><Plus className="mr-1 h-3.5 w-3.5" />添加</Button>
              </div>
            </td>
          </tr>
          {filteredRows.map((row: any) => (
            <tr key={row.id} className="border-b last:border-0 hover:bg-slate-50/60">
              {editId === row.id ? (
                <>
                  {renderRow(editDraft, setEditDraft)}
                  <td className="px-4 py-2.5">
                    <div className="flex justify-center gap-1">
                      <button className="rounded p-1 text-emerald-600 hover:bg-emerald-50" onClick={saveEdit}><Check className="h-4 w-4" /></button>
                      <button className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={() => setEditId(null)}><X className="h-4 w-4" /></button>
                    </div>
                  </td>
                </>
              ) : (
                <>
                  <td className="px-4 py-2.5 font-medium">{row.name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{row.baseUrl}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{row.authCode}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${tagColor(row.meterTag)}`}>{row.meterTag}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{row.remark ?? "-"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-center gap-1">
                      <button className="rounded p-1 text-slate-400 hover:text-blue-600" title="测试连接"
                        onClick={() => doTest({ baseUrl: row.baseUrl, authCode: row.authCode }, row.id)}>
                        <PlugZap className={`h-4 w-4 ${testingId === row.id ? "animate-pulse text-blue-500" : ""}`} />
                      </button>
                      <button className="rounded p-1 text-slate-400 hover:text-emerald-600" onClick={() => startEdit(row)}><Pencil className="h-4 w-4" /></button>
                      <button className="rounded p-1 text-slate-400 hover:text-rose-500"
                        onClick={() => window.confirm("删除该配置？") && deleteThirdPartyConfig(row.id).then(() => { toast.success("已删除"); invalidate(); })}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </>
              )}
            </tr>
          ))}
          {filteredRows.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">暂无配置，请添加第三方接口账户</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── 预警设置 ───
function AlertSettingsTable() {
  const queryClient = useQueryClient();
  const cfg = useQuery({ queryKey: ["alertConfig"], queryFn: getAlertConfig });
  const [draft, setDraft] = useState<{ elecYoyRatio: string; expireDaysVenue: string; expireDaysBrand: string }>({ elecYoyRatio: "", expireDaysVenue: "", expireDaysBrand: "" });

  // 数据加载后回填表单
  const loaded = useMemo(() => {
    if (!cfg.data) return false;
    setDraft({
      elecYoyRatio: String(cfg.data.elecYoyRatio ?? 1.5),
      expireDaysVenue: String(cfg.data.expireDaysVenue ?? 30),
      expireDaysBrand: String(cfg.data.expireDaysBrand ?? 30),
    });
    return true;
  }, [cfg.data]);

  const save = async () => {
    const ratio = Number(draft.elecYoyRatio);
    const dv = Number(draft.expireDaysVenue);
    const db = Number(draft.expireDaysBrand);
    if (!(ratio >= 1) || !(dv >= 0) || !(db >= 0)) { toast.error("上涨比例 ≥1，提前天数 ≥0"); return; }
    try {
      await saveAlertConfig({ elecYoyRatio: ratio, expireDaysVenue: dv, expireDaysBrand: db });
      toast.success("预警设置已保存");
      queryClient.invalidateQueries({ queryKey: ["alertConfig"] });
    } catch (e: any) { toast.error(e.message || "保存失败"); }
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <AlertTriangle className="h-4 w-4 text-amber-500" />预警设置
        </span>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={save}><Check className="mr-1 h-3.5 w-3.5" />保存</Button>
      </div>
      <div className="space-y-5 p-5">
        {/* 电量异常 */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">电量异常</span>
            <span className="text-sm font-medium text-slate-700">电量同比上涨预警阈值</span>
          </div>
          <div className="flex items-center gap-3">
            <input type="number" step="0.1" min="1" className={`${inputCls} w-28`} value={draft.elecYoyRatio}
              onChange={(e) => setDraft((p) => ({ ...p, elecYoyRatio: e.target.value }))} />
            <span className="text-xs text-slate-500">倍（本月用电量 ÷ 去年同期 ≥ 该值预警；如 1.5 = 上涨 50%）</span>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">预警页按「最近月份 vs 去年同月」对比各电表用电量。</p>
        </div>

        <div className="border-t" />

        {/* 合同到期 */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">合同预警</span>
            <span className="text-sm font-medium text-slate-700">合同到期提前提醒天数</span>
          </div>
          <div className="grid max-w-xl grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs text-slate-500">场地合同（应付）提前天数</label>
              <input type="number" min="0" className={`${inputCls} w-28`} value={draft.expireDaysVenue}
                onChange={(e) => setDraft((p) => ({ ...p, expireDaysVenue: e.target.value }))} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">品牌方合同（应收）提前天数</label>
              <input type="number" min="0" className={`${inputCls} w-28`} value={draft.expireDaysBrand}
                onChange={(e) => setDraft((p) => ({ ...p, expireDaysBrand: e.target.value }))} />
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            剩余天数 ≤ 提前天数即提醒（含已到期）；同时会提醒「有逾期未收/付分期」的合同（分期结束日期已过仍未收/付）。
          </p>
        </div>
      </div>
      {!loaded && <div className="px-5 pb-5 text-[11px] text-slate-400">加载配置中…</div>}
    </div>
  );
}

export default function Directory() {
  const brands = useQuery({ queryKey: ["brands"], queryFn: listBrands });
  const entities = useQuery({ queryKey: ["entities"], queryFn: listEntities });
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: listLandlords });
  const shareholders = useQuery({ queryKey: ["shareholders"], queryFn: listShareholders });
  const introducers = useQuery({ queryKey: ["introducers"], queryFn: listIntroducers });
  const thirdPartyConfigs = useQuery({ queryKey: ["thirdPartyConfigs"], queryFn: listThirdPartyConfigs });

  return (
    <Tabs defaultValue="brands">
      <TabsList>
        <TabsTrigger value="brands">品牌方（{brands.data?.length ?? 0}）</TabsTrigger>
        <TabsTrigger value="entities">公司主体（{entities.data?.length ?? 0}）</TabsTrigger>
        <TabsTrigger value="landlords">场地方/业主（{landlords.data?.length ?? 0}）</TabsTrigger>
        <TabsTrigger value="shareholders">股东（{shareholders.data?.length ?? 0}）</TabsTrigger>
        <TabsTrigger value="introducers">介绍人（{introducers.data?.length ?? 0}）</TabsTrigger>
        <TabsTrigger value="users">平台人员</TabsTrigger>
        <TabsTrigger value="third-party">第三方接口配置（{thirdPartyConfigs.data?.length ?? 0}）</TabsTrigger>
        <TabsTrigger value="alerts">预警设置</TabsTrigger>
      </TabsList>
      <div className="mt-4">
        <TabsContent value="brands">
          <CrudTable title="品牌方档案" rows={brands.data}
            columns={[{ key: "name", label: "名称" }, { key: "contact", label: "联系人" }, { key: "remark", label: "备注" }]}
            onCreate={createBrand} onUpdate={(id, v) => updateBrand(id, v)} onDelete={deleteBrand} />
        </TabsContent>
        <TabsContent value="entities">
          <CrudTable title="公司主体档案" rows={entities.data}
            columns={[{ key: "name", label: "公司全称" }, { key: "short_name", label: "简称" }, { key: "remark", label: "备注" }]}
            onCreate={(v) => createEntity({ name: v.name, shortName: v.shortName, remark: v.remark })} onUpdate={(id, v) => updateEntity(id, { name: v.name, shortName: v.shortName, remark: v.remark })} onDelete={deleteEntity} />
        </TabsContent>
        <TabsContent value="landlords">
          <CrudTable title="场地方 / 业主档案" rows={landlords.data}
            columns={[{ key: "name", label: "名称" }, { key: "contact", label: "联系人" }, { key: "phone", label: "电话" }, { key: "remark", label: "备注" }]}
            onCreate={createLandlord} onUpdate={(id, v) => updateLandlord(id, v)} onDelete={deleteLandlord} />
        </TabsContent>
        <TabsContent value="shareholders">
          <CrudTable title="股东档案" rows={shareholders.data}
            columns={[{ key: "name", label: "姓名" }, { key: "phone", label: "电话" }, { key: "remark", label: "备注" }]}
            onCreate={createShareholder} onUpdate={(id, v) => updateShareholder(id, v)} onDelete={deleteShareholder} />
        </TabsContent>
        <TabsContent value="introducers">
          <CrudTable title="介绍人档案" rows={introducers.data}
            columns={[{ key: "name", label: "姓名" }, { key: "phone", label: "电话" }, { key: "remark", label: "备注" }]}
            onCreate={createIntroducer} onUpdate={(id, v) => updateIntroducer(id, v)} onDelete={deleteIntroducer} />
        </TabsContent>
        <TabsContent value="users">
          <PlatformUsersTable shareholders={shareholders.data} landlords={landlords.data} />
        </TabsContent>
        <TabsContent value="third-party">
          <ThirdPartyConfigsTable />
        </TabsContent>
        <TabsContent value="alerts">
          <AlertSettingsTable />
        </TabsContent>
      </div>
    </Tabs>
  );
}
