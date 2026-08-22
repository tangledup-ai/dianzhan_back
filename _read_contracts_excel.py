# -*- coding: utf-8 -*-
"""解析场地信息关联表（测试1）.xlsx"""
import zipfile, re

path = r"F:\DieJiaTai\项目开发\水库管理平台\项目相关文件\聊天文件\场地信息关联表（测试1）.xlsx"
z = zipfile.ZipFile(path)
print("files:", z.namelist())

shared = []
xml = z.read("xl/sharedStrings.xml").decode("utf-8")
for si in re.findall(r"<si>(.*?)</si>", xml, re.S):
    parts = re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)
    shared.append("".join(parts))
print("sharedStrings 数量:", len(shared))
for i, s in enumerate(shared[:200]):
    print(f"  [{i}] {s.replace(chr(10), ' | ')}")

for n in z.namelist():
    if re.match(r"xl/worksheets/sheet\d+\.xml", n):
        sx = z.read(n).decode("utf-8")
        rows = re.findall(r'<row[^>]*r="(\d+)"', sx)
        print(f"{n}: {len(rows)} rows")

# 读 sheet1 的单元格（行×列 → shared index / inline）
if "xl/worksheets/sheet1.xml" in z.namelist():
    sx = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    # 提取每个 cell: r="A1" t="s" v="3" 或 inline <is><t>
    print("\n== sheet1 单元格 ==")
    for m in re.finditer(r'<c r="([A-Z]+\d+)"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>([^<]*)</v>|<is><t[^>]*>([^<]*)</t></is>)?</c>', sx):
        ref, t, v, inline = m.groups()
        val = v if v is not None else (inline or "")
        if t == "s" and v is not None:
            idx = int(v)
            val = shared[idx] if idx < len(shared) else f"?{idx}"
        if val not in ("", None):
            print(f"  {ref}: {val}")
