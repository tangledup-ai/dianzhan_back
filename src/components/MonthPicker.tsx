import { useState, useRef, useEffect } from "react";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";

interface MonthPickerProps {
  value: string; // YYYY-MM
  onChange: (value: string) => void;
  className?: string;
  /** 弹出面板对齐方向：默认左对齐（left-0）；容器较窄时用 right 避免右溢出被裁剪 */
  align?: "left" | "right";
}

export function MonthPicker({ value, onChange, className, align = "left" }: MonthPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => {
    if (value) {
      return parseInt(value.split("-")[0]);
    }
    return new Date().getFullYear();
  });
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const months = [
    { value: 1, label: "1月" },
    { value: 2, label: "2月" },
    { value: 3, label: "3月" },
    { value: 4, label: "4月" },
    { value: 5, label: "5月" },
    { value: 6, label: "6月" },
    { value: 7, label: "7月" },
    { value: 8, label: "8月" },
    { value: 9, label: "9月" },
    { value: 10, label: "10月" },
    { value: 11, label: "11月" },
    { value: 12, label: "12月" },
  ];

  const handleSelectMonth = (month: number) => {
    const newValue = `${viewYear}-${String(month).padStart(2, "0")}`;
    onChange(newValue);
    setIsOpen(false);
  };

  const displayText = value
    ? `${parseInt(value.split("-")[0])}年${parseInt(value.split("-")[1])}月`
    : "选择月份";

  return (
    <div ref={ref} className={cn("relative", className)}>
      {/* 触发按钮 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex h-9 w-40 items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm",
          "hover:border-emerald-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500",
          !value && "text-slate-400"
        )}
      >
        <span>{displayText}</span>
        <Calendar className="h-4 w-4 text-slate-400" />
      </button>

      {/* 弹出面板 */}
      {isOpen && (
        <div className={cn("absolute top-full z-50 mt-1 w-48 rounded-lg border bg-white p-2.5 shadow-lg", align === "right" ? "right-0" : "left-0")}>
          {/* 年份选择 */}
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => setViewYear(viewYear - 1)}
              className="rounded p-1 hover:bg-slate-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold">{viewYear}年</span>
            <button
              onClick={() => setViewYear(viewYear + 1)}
              className="rounded p-1 hover:bg-slate-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* 月份网格 */}
          <div className="grid grid-cols-4 gap-1">
            {months.map((m) => {
              const isSelected =
                value === `${viewYear}-${String(m.value).padStart(2, "0")}`;
              const isCurrent =
                viewYear === new Date().getFullYear() &&
                m.value === new Date().getMonth() + 1;

              return (
                <button
                  key={m.value}
                  onClick={() => handleSelectMonth(m.value)}
                  className={cn(
                    "rounded-md px-1 py-1.5 text-sm transition-colors",
                    isSelected
                      ? "bg-emerald-600 text-white"
                      : isCurrent
                      ? "bg-emerald-50 text-emerald-700 font-medium"
                      : "hover:bg-slate-100 text-slate-700"
                  )}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          {/* 快捷操作 */}
          <div className="mt-3 flex justify-between border-t pt-2">
            <button
              onClick={() => {
                const now = new Date();
                const newValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
                onChange(newValue);
                setViewYear(now.getFullYear());
                setIsOpen(false);
              }}
              className="text-xs text-emerald-600 hover:underline"
            >
              本月
            </button>
            <button
              onClick={() => {
                onChange("");
                setIsOpen(false);
              }}
              className="text-xs text-slate-400 hover:underline"
            >
              清除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
