# 三个页面改造前的设计留档（v1）

**留档时间**：2026-09-27
**留档原因**：主人要求「改造智慧电表 / 场租台账 / 电费台账 三个页面之前，先把当前设计保留下来」。

## 回滚版本点

| 项 | 值 |
|---|---|
| git commit | `cbecb77196675b7b1a96a9867f12d82a081d724e`（`cbecb77 docs: 新增数据溯源手册 DATA_LINEAGE.md`） |
| 工作区状态 | 改造前 **这三个页面无任何未提交改动**（干净基线） |

## 留档文件

| 文件 | 对应源文件 |
|---|---|
| `Meters.tsx.v1bak` | `src/pages/Meters.tsx`（智慧电表） |
| `Rent.tsx.v1bak` | `src/pages/Rent.tsx`（场租台账） |
| `Electricity.tsx.v1bak` | `src/pages/Electricity.tsx`（电费台账） |
| `Layout.tsx.v1bak` | `src/components/Layout.tsx`（左右布局，本次不改，留作对照） |
| `Stat.tsx.v1bak` | `src/components/Stat.tsx`（StatCard / StatusBadge / Money，复用到本次改造） |

## 两种回滚方式

```bash
# 方式一：git 回滚（推荐，最干净）
git checkout -- src/pages/Meters.tsx src/pages/Rent.tsx src/pages/Electricity.tsx

# 方式二：用本目录的留档覆盖回去
cp docs/backup_pages_v1_20260927/Meters.tsx.v1bak        src/pages/Meters.tsx
cp docs/backup_pages_v1_20260927/Rent.tsx.v1bak          src/pages/Rent.tsx
cp docs/backup_pages_v1_20260927/Electricity.tsx.v1bak   src/pages/Electricity.tsx
```

> 想同时保留"改造后"的版本做对比，改造完可以再复制一份到 `docs/backup_pages_v2_<日期>/`。
