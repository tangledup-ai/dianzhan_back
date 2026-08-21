import type { ReactNode } from "react";

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
