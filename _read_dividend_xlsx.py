# -*- coding: utf-8 -*-
"""解析两个分红参考 xlsx（zipfile 直读，绕过 openpyxl 样式解析）"""
import zipfile, re

def read_xlsx(path, max_str=200):
    z = zipfile.ZipFile(path)
    print(f"===== {path.split(chr(92))[-1]} =====")
    print("sheets:", [n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml", n)])
    # sharedStrings
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        xml = z.read("xl/sharedStrings.xml").decode("utf-8")
        for si in re.findall(r"<si>(.*?)</si>", xml, re.S):
            parts = re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)
            shared.append("".join(parts))
    print("sharedStrings 数量:", len(shared))
    for i, s in enumerate(shared[:max_str]):
        t = s.replace("&#10;", "\\n")
        print(f"  [{i}] {t}")
    # 每个 sheet 的行列数
    for n in z.namelist():
        if re.match(r"xl/worksheets/sheet\d+\.xml", n):
            xml = z.read(n).decode("utf-8")
            rows = re.findall(r"<row[^>]*r=\"(\d+)\"[^>]*>", xml)
            print(f"  {n}: {len(rows)} rows, max col ref: {max(re.findall(r'<c r=\"([A-Z]+)\d+\"', xml), key=lambda x: len(x)) if rows else '-'}")
    return shared

p1 = r"F:\DieJiaTai\项目开发\水库管理平台\项目相关文件\聊天文件\2026年刘洋分红表.xlsx"
p2 = r"F:\DieJiaTai\项目开发\水库管理平台\项目相关文件\聊天文件\2026年刘陈李路--宏仁社区1号超级换电站分红.xlsx"
read_xlsx(p1)
print()
read_xlsx(p2)
