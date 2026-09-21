import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createDividend } from "@/api/dividends";
import { listLandlords } from "@/api/directory";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, TextInput, SelectInput, SearchSelect } from "./fields";
import { strOrNull } from "@/lib/format";
import { toast } from "sonner";

export type DividendRow = {
  id: number; landlordId: number; period: string; type: string;
  profit: string | null; status: string; remark: string | null;
  shares: { shareholderId: number; ratio: string; shareholder_name: string | null; amount: string | null }[];
};

export function DividendForm(props: { open: boolean; onClose: () => void; record?: DividendRow | null; presetLandlordId?: number }) {
  const blank = {
    landlordId: "", period: new Date().toISOString().slice(0, 7), type: "股东分红", remark: "",
  };
  const [f, setF] = useState(blank);
  const queryClient = useQueryClient();
  const landlords = useQuery({ queryKey: ["landlords"], queryFn: () => listLandlords(), enabled: props.open });

  useEffect(() => {
    if (!props.open) return;
    if (props.record) {
      setF({
        landlordId: String(props.record.landlordId), period: props.record.period,
        type: props.record.type, remark: props.record.remark ?? "",
      });
    } else {
      setF({ ...blank, landlordId: props.presetLandlordId ? String(props.presetLandlordId) : "" });
    }
  }, [props.open, props.record]);

  const set = (k: keyof typeof blank) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: createDividend,
    onSuccess: () => { toast.success("分红记录已保存"); queryClient.invalidateQueries(); props.onClose(); },
    onError: (e: any) => toast.error(e.message),
  });

  const submit = () => {
    if (!f.landlordId) { toast.error("请选择场地方"); return; }
    save.mutate({
      landlordId: Number(f.landlordId), period: f.period, type: f.type, remark: strOrNull(f.remark),
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{props.record ? "编辑" : "新增"}分红月结</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Field label="场地方 *">
              <SearchSelect value={f.landlordId} onChange={set("landlordId")} placeholder="请选择场地方（可搜索）" clearable={false}
                options={(landlords.data ?? []).map((st: any) => ({ value: String(st.id), label: st.name }))} />
            </Field>
            <Field label="分红月份">
              <input type="month" className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm" value={f.period} onChange={(e) => set("period")(e.target.value)} />
            </Field>
            <Field label="分红类型">
              <SelectInput value={f.type} onChange={set("type")}
                options={[{ value: "股东分红", label: "股东分红" }, { value: "商务分红", label: "商务分红" }]} />
            </Field>
          </div>

          <Field label="备注" span><TextInput value={f.remark} onChange={set("remark")} /></Field>

          <div className="rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-500">
            提交后系统将自动根据场地方的分红配置计算分红金额
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={props.onClose}>取消</Button>
            <Button onClick={submit} disabled={save.isPending} className="bg-emerald-600 hover:bg-emerald-700">保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
