import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function Field({ label, children, span }: { label: string | ReactNode; children: ReactNode; span?: boolean }) {
  return (
    <label className={`block ${span ? "col-span-2" : ""}`}>
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export const inputCls =
  "rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500";

export function NumInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; step?: string; disabled?: boolean }) {
  return (
    <input
      type="number"
      step={props.step ?? "any"}
      className={`${inputCls} w-full tabular-nums ${props.disabled ? "bg-slate-50 text-slate-400 cursor-not-allowed" : ""}`}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function TextInput(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className={`${inputCls} w-full`} value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />;
}

export function DateInput(props: { value: string; onChange: (v: string) => void }) {
  return <input type="date" className={`${inputCls} w-full`} value={props.value} onChange={(e) => props.onChange(e.target.value)} />;
}

export function SelectInput(props: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select className={`${inputCls} w-full`} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// 可搜索下拉（既可选择，也可输入关键字模糊过滤）
export function SearchSelect(props: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const selected = props.options.find((o) => o.value === props.value);
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return kw ? props.options.filter((o) => o.label.toLowerCase().includes(kw)) : props.options;
  }, [props.options, keyword]);
  return (
    <div className="relative">
      <button
        type="button"
        className={inputCls + " flex w-full items-center justify-between text-left"}
        onClick={() => { setOpen((o) => !o); setKeyword(""); }}
      >
        <span className={`truncate ${selected ? "text-slate-700" : "text-slate-400"}`}>{selected?.label ?? props.placeholder ?? "请选择"}</span>
        <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg">
            <div className="p-1.5">
              <input
                autoFocus
                className={inputCls + " w-full text-xs"}
                placeholder="输入关键字搜索…"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
              />
            </div>
            <div className="max-h-48 overflow-y-auto pb-1">
              {filtered.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  className={`block w-full px-2.5 py-1.5 text-left text-xs hover:bg-emerald-50 ${o.value === props.value ? "font-medium text-emerald-700" : "text-slate-600"}`}
                  onClick={() => { props.onChange(o.value); setOpen(false); }}
                >
                  {o.label}
                </button>
              ))}
              {filtered.length === 0 && <div className="px-2.5 py-1.5 text-xs text-slate-400">无匹配项</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
