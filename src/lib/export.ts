import * as XLSX from "xlsx";

export interface ExportSheet {
  name: string;
  rows: Record<string, unknown>[];
}

/** 导出一个或多个 sheet 到 xlsx */
export function exportXlsx(filename: string, sheets: ExportSheet[]) {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.json_to_sheet(sheet.rows);
    // 自动列宽
    const keys = Object.keys(sheet.rows[0] ?? {});
    ws["!cols"] = keys.map((k) => ({
      wch: Math.max(
        k.length * 2,
        ...sheet.rows.slice(0, 200).map((r) => String(r[k] ?? "").length * 1.9),
        8,
      ),
    }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}

/** 导出带标题行的 sheet（首行合并居中），数据为二维数组 */
export function exportXlsxWithTitle(filename: string, opts: {
  sheetName: string;
  title: string;
  headers: string[];
  rows: unknown[][];
}) {
  const wb = XLSX.utils.book_new();

  // 构建 aoa：标题行 + 表头行 + 数据行
  const aoa: unknown[][] = [
    [opts.title],
    opts.headers,
    ...opts.rows,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // 合并标题行
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: opts.headers.length - 1 } }];

  // 自动列宽
  ws["!cols"] = opts.headers.map((h, ci) => ({
    wch: Math.max(
      h.length * 2,
      ...opts.rows.slice(0, 200).map((r) => String(r[ci] ?? "").length * 1.9),
      8,
    ),
  }));

  XLSX.utils.book_append_sheet(wb, ws, opts.sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}
