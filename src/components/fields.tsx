import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";

// 注意：这里刻意用 div 而不是 label 包裹。
// label 会把内部「非交互区域」的点击转发给第一个表单控件：SearchSelect 的
// 外部点击关闭区域/下拉空白处都是普通 div，点击空白 → 先关闭下拉、又被转发成
// 一次按钮点击重新打开，表现为「不选中一项就关不掉」。
export function Field({ label, children, span }: { label: string | ReactNode; children: ReactNode; span?: boolean }) {
  return (
    <div className={`block ${span ? "col-span-2" : ""}`}>
      <div className="mb-1 block text-xs font-medium text-slate-500">{label}</div>
      {children}
    </div>
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
  /** 已选中时是否显示「清除」按钮（默认显示），清除后回传空字符串 */
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = props.options.find((o) => o.value === props.value);
  const showClear = props.clearable !== false && props.value !== "" && !!selected;
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return kw ? props.options.filter((o) => o.label.toLowerCase().includes(kw)) : props.options;
  }, [props.options, keyword]);

  const close = () => { setOpen(false); setKeyword(""); };

  // 打开时判断下方空间：滚动容器/视口底部放不下就改为向上弹出，避免下拉被裁切
  const openPanel = () => {
    const el = rootRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      let limit = window.innerHeight;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === "auto" || oy === "scroll" || oy === "hidden") {
          limit = Math.min(limit, p.getBoundingClientRect().bottom);
        }
      }
      setDropUp(limit - rect.bottom < 260 && rect.top > 260);
    }
    setOpen(true);
    setKeyword("");
  };

  // 点击组件外任意位置即关闭：用 document 监听而不是铺一层透明遮罩，
  // 这样第一次点击既能关掉下拉、又能正常落到用户真正想点的字段上。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) { setOpen(false); setKeyword(""); }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Esc 只关闭下拉本身，不关闭外层弹窗（Radix Dialog 在 document 捕获阶段监听 Esc，
  // 因此在 window 捕获阶段拦下并阻止继续传播）。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setKeyword("");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={inputCls + " flex w-full items-center justify-between text-left" + (showClear ? " pr-6" : "")}
        onClick={() => { if (open) { close(); } else { openPanel(); } }}
      >
        <span className={`truncate ${selected ? "text-slate-700" : "text-slate-400"}`}>{selected?.label ?? props.placeholder ?? "请选择"}</span>
        <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>
      {showClear && (
        <button
          type="button"
          aria-label="清除选择"
          title="清除选择"
          className="absolute right-6 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          onClick={() => { props.onChange(""); close(); }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {open && (
        <div className={"absolute z-50 w-full rounded-md border border-slate-200 bg-white shadow-lg" + (dropUp ? " bottom-full mb-1" : " mt-1")}>
          <div className="p-1.5">
            <input
              autoFocus
              className={inputCls + " w-full text-xs"}
              placeholder="输入关键字搜索…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <div className="max-h-48 overflow-y-auto pb-1">
            {filtered.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`block w-full px-2.5 py-1.5 text-left text-xs hover:bg-emerald-50 ${o.value === props.value ? "font-medium text-emerald-700" : "text-slate-600"}`}
                onClick={() => { props.onChange(o.value); close(); }}
              >
                {o.label}
              </button>
            ))}
            {filtered.length === 0 && <div className="px-2.5 py-1.5 text-xs text-slate-400">无匹配项</div>}
          </div>
        </div>
      )}
    </div>
  );
}
