-- ============================================================
-- 2026_08_table_comments.sql
-- 表注释脚本（Navicat 查询窗口直接执行，幂等）
--
-- 用途：给全部 39 张表 + 2 个视图填充「表注释」（Navicat 显示的表备注）。
-- 幂等：COMMENT ON 重复执行只是覆盖，无副作用，可反复跑。
-- 用法：Navicat → 打开你的数据库 → 新建查询 → 粘贴执行。
-- 注意：若提示某表不存在，说明该表是 v2 新增（你的库还没有），
--       先执行 database_init.sql（v2 全量建表）后再跑本脚本即可。
-- ============================================================

-- ── 档案域 ──────────────────────────────────────────────
COMMENT ON TABLE brands IS '品牌方（客户/收入来源，如美团/哈啰/青桔）';
COMMENT ON TABLE entities IS '公司主体（报税法人，收款/付款主体）';
COMMENT ON TABLE landlords IS '场地方（业主，主链聚合根：站点/合同/电表都挂它名下）';
COMMENT ON TABLE shareholders IS '股东（投资人，分红受益人）';
COMMENT ON TABLE introducers IS '介绍人（商务关系人，拿商务分红）';
COMMENT ON TABLE entity_brands IS '公司主体-品牌方 归属关系（多对多）';
COMMENT ON TABLE platform_users IS '平台登录用户（老板/财务/股东；股东限看关联场地）';

-- ── 站点域 ──────────────────────────────────────────────
COMMENT ON TABLE stations IS '站点（主链枢纽）：场地下的经营单元，电表归它管';

-- ── 电表·接入域（第三方平台缓存，只能 GET 拉取）──────────
COMMENT ON TABLE third_party_configs IS '第三方电表平台账户配置（地址+授权码+电表类型）';
COMMENT ON TABLE meter_devices IS '第三方设备快照（address=业务电表号）';
COMMENT ON TABLE meter_collectors IS '第三方采集器快照';
COMMENT ON TABLE meter_status_cache IS '电表实时状态缓存（总电量/分时电量/剩余金额）';
COMMENT ON TABLE meter_monthly IS '月度读数（电费/分红的数据源头），每表每月一条';
COMMENT ON TABLE meter_daily IS '日用电量（原始表码）';
COMMENT ON TABLE meter_hourly IS '小时用电量（原始表码）';
COMMENT ON TABLE meter_yearly IS '年用电量（原始表码）';
COMMENT ON TABLE meter_warnings_cache IS '电表报警缓存';
COMMENT ON TABLE sync_logs IS '第三方同步日志（审计：同步类型/成功失败/条数）';

-- ── 电表·档案域（业务计算唯一入口）───────────────────────
COMMENT ON TABLE meters IS '电表档案：第三方设备导入/人工建档，挂到站点/品牌/场地/主体';
COMMENT ON TABLE cabinets IS '柜子（挂电表下）；计费柜数从这里实时统计';

-- ── 合同域（商务量唯一主源）──────────────────────────────
COMMENT ON TABLE contracts IS '合同台账：场地合同=成本（付业主）/品牌方合同=收入（品牌方付公司）；单价/月租/税都在这里';
COMMENT ON TABLE rent_payment_schedule IS '场地合同付款分期（按付款方式拆期）';
COMMENT ON TABLE rent_income_schedule IS '品牌方合同收款分期（按付款方式拆期）';

-- ── 分配规则域（分红怎么分）──────────────────────────────
COMMENT ON TABLE station_shareholder_configs IS '股东分红配置（每站每股东：收入/利润/固定金额 + 比例 + 生效期）';
COMMENT ON TABLE station_introducer_configs IS '介绍人商务分红配置（同上 + 是否计入成本）';

-- ── 台账派生域（源头数据算出的账本/快照）────────────────
COMMENT ON TABLE electricity_records IS '电费月台账（每站每月：付电费/收电费/利润）';
COMMENT ON TABLE electricity_meter_details IS '电费台账分表明细（每块电表贡献多少）';
COMMENT ON TABLE operating_expenses IS '运营费用（每站每月手工填一笔）';
COMMENT ON TABLE dividend_records IS '分红月结（每站每月：收入-成本=利润，状态流转）';
COMMENT ON TABLE dividend_shares IS '分红明细（每个股东/介绍人分到多少，含配置快照）';

-- ── 审批域 ──────────────────────────────────────────────
COMMENT ON TABLE approval_flows IS '审批流程配置（业务类型走哪几个审批节点）';
COMMENT ON TABLE approval_requests IS '审批单（电费/租金/分红等付款申请）';
COMMENT ON TABLE approval_records IS '审批流转记录（谁在哪个节点通过/驳回）';
COMMENT ON TABLE approval_dividend_records IS '审批单与分红记录关系（一张审批单可带多个月分红）';

-- ── 过渡表（已废弃，不再作数据源，实施轮并入主表后下线）──
COMMENT ON TABLE rent_leases IS 'DEPRECATED 旧场地租金付款台账（被 contracts 场地合同取代）';
COMMENT ON TABLE rent_incomes IS 'DEPRECATED 旧品牌租金收款台账（被 contracts 品牌方合同取代）';
COMMENT ON TABLE rent_receipts IS 'DEPRECATED 旧收款分期（被 rent_income_schedule 取代）';
COMMENT ON TABLE rent_payment_records IS '年度付款台账（发票归档，保留）';
COMMENT ON TABLE rent_income_records IS '年度收款台账（进项成本归档，保留）';

-- ── 视图 ────────────────────────────────────────────────
COMMENT ON VIEW landlord_site_summary IS '场地维度实时汇总：租金成本/收入/合同清单（只读不落缓存）';
COMMENT ON VIEW landlord_monthly_summary IS '场地月度经营汇总（跨表聚合）：电费收支+税费/租金收支+税费/运营费用/净利润/分红，按场地×月份一行';
