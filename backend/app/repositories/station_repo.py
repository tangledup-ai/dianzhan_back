"""站点仓储（v3：已删除站点层，stations 表下线）。

v3 架构为「场地方(landlord)→电表」两层，站点 CRUD 及其路由由 stations.py 一并移除；
本模块保留为空占位，避免旧引用（stations.py / dividend_calc.py）导入时报错。
"""
