-- ============================================================
-- huandian_v2 → huandian_v5 数据迁移脚本
-- ============================================================
-- 口径依据：METER_DOMAIN_V5.md
--   · 只有【第三方来源的电表月度读数】是真实的 ⇒ 全迁
--   · 合同/账单/分红等是测试数据 ⇒ 结构类（合同）保留，账单类（台账/分期）舍弃
--
-- 迁移范围：
--   ✅ 迁移：档案域、电表域、第三方接入域（含读数/缓存）、合同域、共享表分摊
--   ❌ 舍弃：electricity_records / electricity_meter_details / rent_*_schedule /
--            operating_expenses / dividend_* / landlord_*_configs /
--            approval_requests / approval_records  （全是测试数据，将由新口径重新生成）
--
-- 数据修正（脚本内已实现，另有日志）：
--   1) meters.tag → category_code（合作商电表→partner / 民用电表→civil / 共享电表→shared）
--   2) is_shared：仅 3 块真共享表（id 99 大观2 / 119 龙泉路108 / 126 学府路68）= TRUE
--      滇池 id 8 / 62 系历史误标 → 改判普通合作商表（category=partner、补品牌、is_shared=FALSE）
--   3) transformer_ratio = 0 的 2 块表（id 133/134）→ 修正为 1（口径：默认 1）
--   4) meters.status：'正常' → 'active'
--   5) 读数的人工值统一到 actual_kwh（表码差 × 倍数）
--   6) meter_shared_brand_bindings：由历史分摊行推导
--
-- 舍弃的数据：
--   · 32 行读数对应不到电表（15 个平台设备地址 + 5 行空地址）—— 这些设备尚未建档，需人工归位
--
-- 执行：psql -U quant -d huandian_v5 -f migrate_v2_to_v5.sql
-- 幂等：可重复执行（先 TRUNCATE 目标表）
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- ════════════════════════════════════════════════════════════
-- §0  跨库挂载（postgres_fdw）
-- ════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS postgres_fdw;
DROP SCHEMA IF EXISTS src CASCADE;
DROP SERVER IF EXISTS src CASCADE;
CREATE SERVER src FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host '127.0.0.1', port '5432', dbname 'huandian_v2');
CREATE USER MAPPING FOR quant SERVER src
    OPTIONS (user 'quant', password 'quant-speed123');
CREATE SCHEMA src;
IMPORT FOREIGN SCHEMA public LIMIT TO (
    brands, entities, landlords, landlord_owners, shareholders, introducers,
    entity_brands, platform_users,
    meters, cabinets, meter_entity_changes,
    third_party_configs, meter_devices, meter_collectors, meter_status_cache,
    meter_monthly, meter_daily, meter_hourly, meter_yearly, meter_warnings_cache, sync_logs,
    contracts, contract_audit_log,
    meter_shared_allocations, approval_flows
) FROM SERVER src INTO src;

-- ════════════════════════════════════════════════════════════
-- §1  清空目标（保证可重复执行）
-- ════════════════════════════════════════════════════════════
TRUNCATE
    meter_readings, meter_shared_brand_bindings, meter_shared_allocations,
    meter_entity_changes, cabinets, meters,
    meter_daily, meter_hourly, meter_yearly, meter_warnings_cache,
    meter_collectors, meter_status_cache, meter_devices, third_party_configs, sync_logs,
    contract_audit_log, contracts,
    landlord_owners, platform_users, entity_brands, introducers, shareholders,
    entities, landlords, brands,
    approval_flows
RESTART IDENTITY CASCADE;

-- ════════════════════════════════════════════════════════════
-- §2  档案域
-- ════════════════════════════════════════════════════════════
INSERT INTO brands (id, name, contact, remark, created_at)
SELECT id, name, contact, remark, created_at FROM src.brands;

INSERT INTO entities (id, name, short_name, tax_no, taxpayer_type, invoice_bank,
                      invoice_account, invoice_address, invoice_phone, status, sort, remark, created_at)
SELECT id, name, short_name, tax_no, taxpayer_type, invoice_bank,
       invoice_account, invoice_address, invoice_phone, status, sort, remark, created_at
FROM src.entities;

INSERT INTO landlords (id, name, contact, phone, region, address, latitude, longitude, remark, created_at)
SELECT id, name, contact, phone, region, address, latitude, longitude, remark, created_at
FROM src.landlords;

INSERT INTO landlord_owners (id, landlord_id, owner_name, phone, start_date, remark, created_at)
SELECT id, landlord_id, owner_name, phone, start_date, remark, created_at FROM src.landlord_owners;

INSERT INTO shareholders (id, name, phone, remark, created_at, updated_at)
SELECT id, name, phone, remark, created_at, updated_at FROM src.shareholders;

INSERT INTO introducers (id, name, phone, remark, created_at, updated_at)
SELECT id, name, phone, remark, created_at, updated_at FROM src.introducers;

INSERT INTO entity_brands (id, entity_id, brand_id, remark, created_at)
SELECT id, entity_id, brand_id, remark, created_at FROM src.entity_brands;

-- 平台用户：meter_tag_scope（中文）额外映射到 v5 新增的 meter_category_scope
INSERT INTO platform_users (id, name, role, shareholder_id, password, landlord_ids,
                            meter_tag_scope, meter_category_scope, phone, remark, created_at)
SELECT id, name, role, shareholder_id, password, landlord_ids,
       meter_tag_scope,
       CASE meter_tag_scope
            WHEN '合作商电表' THEN 'partner'
            WHEN '民用电表'   THEN 'civil'
            WHEN '共享电表'   THEN 'shared'
            ELSE NULL END,
       phone, remark, created_at
FROM src.platform_users;

-- ════════════════════════════════════════════════════════════
-- §3  电表档案域（含全部 V5 修正）
-- ════════════════════════════════════════════════════════════
INSERT INTO meters (
    id, meter_no, meter_name, landlord_id, brand_id, entity_id, entity_source,
    category_code, is_shared, status, transformer_ratio, initial_reading,
    device_address, device_id, collector_id, third_party_config_id,
    data_source, installed_at, removed_at, remark, updated_by, created_at, updated_at, tag
)
SELECT
    s.id,
    s.meter_no,
    s.meter_name,
    -- ★ 外键保护：源库 meters 无 FK 约束，指向不存在场地的孤儿引用 → 置 NULL
    (SELECT l.id FROM src.landlords l WHERE l.id = s.landlord_id),
    -- 滇池 id 8→台铃(1)、id 62→八维通(2)：历史误标改判为普通合作商表
    CASE WHEN s.id = 8 THEN 1
         WHEN s.id = 62 THEN 2
         ELSE (SELECT b.id FROM src.brands b WHERE b.id = s.brand_id) END,
    (SELECT e.id FROM src.entities e WHERE e.id = s.entity_id),
    COALESCE(s.entity_source, 'manual'),
    -- ★ tag → category_code（滇池 id 8/62 系误标，改判为合作商电表）
    CASE
        WHEN s.id IN (8, 62) THEN 'partner'
        WHEN s.tag = '民用电表' THEN 'civil'
        WHEN s.tag = '共享电表' THEN 'shared'
        ELSE 'partner'
    END,
    -- ★ is_shared：只有 99(大观2) / 119(龙泉路108) / 126(学府路68) 是真共享表
    (s.id IN (99,119,126)),
    -- ★ status 中文 → 枚举
    CASE WHEN s.status = '正常' OR s.status IS NULL THEN 'active' ELSE 'inactive' END,
    -- ★ 倍数 0 修正为 1（口径默认 1）
    CASE WHEN COALESCE(s.transformer_ratio, 0) <= 0 THEN 1 ELSE s.transformer_ratio END,
    NULL,
    -- ★ device_address：优先取平台设备地址，取不到就用 meter_no
    COALESCE((SELECT md.address FROM src.meter_devices md WHERE md.address = s.meter_no LIMIT 1),
             s.meter_no),
    (SELECT md.device_id FROM src.meter_devices md WHERE md.address = s.meter_no LIMIT 1),
    s.collector_id,
    NULL,
    -- ★ 有没有接第三方
    CASE WHEN EXISTS (SELECT 1 FROM src.meter_devices md WHERE md.address = s.meter_no)
           OR EXISTS (SELECT 1 FROM src.meter_monthly mm WHERE mm.address = s.meter_no AND mm.synced_at IS NOT NULL)
         THEN 'auto' ELSE 'manual' END,
    NULL, NULL,
    s.remark, NULL, s.created_at, s.updated_at,
    -- 遗留列：滇池两块把 tag 回写为正确的值，便于回溯
    CASE WHEN s.id IN (8,62) THEN '合作商电表' ELSE s.tag END
FROM src.meters s
ORDER BY s.id;

-- 柜子：品牌从【新库电表】派生（含滇池改判后的品牌；共享表 brand_id 本就为空）
INSERT INTO cabinets (id, meter_id, cabinet_no, cabinet_type, brand_id,
                      installed_at, removed_at, data_source, remark, created_at)
SELECT c.id, c.meter_id, c.cabinet_no, c.cabinet_type, m.brand_id,
       NULL, NULL, 'manual', c.remark, c.created_at
FROM src.cabinets c
JOIN meters m ON m.id = c.meter_id;   -- 注意：JOIN 新库 meters（此时已迁移完）

INSERT INTO meter_entity_changes (id, meter_id, meter_no, from_entity_id, to_entity_id,
                                  effective_period, operator, remark, created_at)
SELECT id, meter_id, meter_no, from_entity_id, to_entity_id,
       NULL, operator, remark, created_at
FROM src.meter_entity_changes;

-- ════════════════════════════════════════════════════════════
-- §4  第三方接入域
-- ════════════════════════════════════════════════════════════
INSERT INTO third_party_configs (id, name, base_url, auth_code, meter_tag, is_active, remark, created_at)
SELECT id, name, base_url, auth_code, meter_tag, TRUE, remark, created_at FROM src.third_party_configs;

INSERT INTO meter_devices (id, device_id, collector_id, address, description, rate,
                           meter_id, config_id, synced_at)
SELECT id, device_id, collector_id, address, description, rate,
       -- 用 meters.device_address 反查电表（源库 meter_id 全为空）
       (SELECT m.id FROM meters m WHERE m.device_address = md.address LIMIT 1),
       config_id, synced_at
FROM src.meter_devices md;

INSERT INTO meter_collectors (id, collector_id, description, device_count, raw_data, synced_at)
SELECT id, collector_id, description, device_count, raw_data, synced_at FROM src.meter_collectors;

INSERT INTO meter_status_cache (id, device_id, address, c0, c1, c2, c3, c4, remain_money, synced_at)
SELECT id, device_id, address, c0, c1, c2, c3, c4, remain_money, synced_at FROM src.meter_status_cache;

-- ★ 月度读数（核心）：只迁能对应到电表的行
INSERT INTO meter_readings (
    id, meter_id, period, device_address, device_id,
    kwh, prev_reading, curr_reading, prev_reading_date, curr_reading_date, raw_data,
    actual_kwh, actual_start_date, actual_end_date,
    transformer_ratio_snapshot, data_source, synced_at, remark,
    prev_actual_reading, curr_actual_reading, month_period, address
)
SELECT
    mm.id, m.id, mm.month_period, mm.address, mm.device_id,
    mm.kwh, mm.prev_reading, mm.curr_reading, mm.prev_reading_date, mm.curr_reading_date, mm.raw_data,
    -- ★ 人工值统一到 actual_kwh：优先原 actual_kwh；否则用人工表码差 × 倍数（首月无上期表码 ⇒ 按 0 起算）
    COALESCE(
        mm.actual_kwh,
        CASE WHEN mm.curr_actual_reading IS NOT NULL
             THEN (mm.curr_actual_reading - COALESCE(mm.prev_actual_reading, 0))
                  * COALESCE(m.transformer_ratio, 1)
        END
    ),
    NULL, NULL,
    COALESCE(m.transformer_ratio, 1),
    CASE WHEN mm.synced_at IS NOT NULL THEN 'auto' ELSE 'manual' END,
    mm.synced_at, NULL,
    mm.prev_actual_reading, mm.curr_actual_reading, mm.month_period, mm.address
FROM src.meter_monthly mm
JOIN meters m ON m.meter_no = mm.address      -- ★ 关联键：字符串 → 电表 id
WHERE mm.month_period ~ '^[0-9]{6}$'
ORDER BY mm.id;

INSERT INTO meter_daily (id, device_id, address, day_date, kwh, raw_data, synced_at)
SELECT id, device_id, address, day_date, kwh, raw_data, synced_at FROM src.meter_daily;

INSERT INTO meter_hourly (id, device_id, address, hour_time, kwh, raw_data, synced_at)
SELECT id, device_id, address, hour_time, kwh, raw_data, synced_at FROM src.meter_hourly;

INSERT INTO meter_yearly (id, device_id, address, year_period, kwh, raw_data, synced_at)
SELECT id, device_id, address, year_period, kwh, raw_data, synced_at FROM src.meter_yearly;

INSERT INTO meter_warnings_cache (id, device_type, device_id, device_address, warning_def_id,
                                  start_time, msg, synced_at)
SELECT id, device_type, device_id, device_address, warning_def_id, start_time, msg, synced_at
FROM src.meter_warnings_cache;

INSERT INTO sync_logs (id, sync_type, status, records_synced, error_message, started_at, completed_at)
SELECT id, sync_type, status, records_synced, error_message, started_at, completed_at FROM src.sync_logs;

-- ════════════════════════════════════════════════════════════
-- §5  合同域
-- ════════════════════════════════════════════════════════════
INSERT INTO contracts (
    id, landlord_id, brand_id, entity_id, contract_type, data_source,
    electricity_price, tax_enabled, tax_rate, post_tax_electricity_price,
    rent_calc_method, unit_monthly_rent, monthly_rent, rent_amount, input_cost,
    first_month_rent, rent_refund, early_end_date,
    deposit, deposit_refund_amount, deposit_refund_date, deposit_refund_approval_id,
    pay_method, rent_advance_days, rent_tax_enabled, rent_tax_rate, post_tax_rent_price,
    previous_contract_id,
    start_date, end_date, region, address, latitude, longitude, remark,
    created_at, updated_at,
    partner, cabinets_count, pay_status, auto_split
)
SELECT
    id,
    (SELECT l.id FROM src.landlords l WHERE l.id = landlord_id),   -- 外键保护
    (SELECT b.id FROM src.brands    b WHERE b.id = brand_id),
    (SELECT e.id FROM src.entities  e WHERE e.id = entity_id),
    contract_type, COALESCE(data_source,'manual'),
    electricity_price, tax_enabled, tax_rate, post_tax_electricity_price,
    COALESCE(rent_calc_method, '固定价格'), unit_monthly_rent, monthly_rent, rent_amount, input_cost,
    first_month_rent, rent_refund, early_end_date,
    deposit, deposit_refund_amount, deposit_refund_date, deposit_refund_approval_id,
    pay_method, COALESCE(rent_advance_days, 0), rent_tax_enabled, rent_tax_rate, post_tax_rent_price,
    NULL,
    start_date, end_date, region, address, latitude, longitude, remark,
    created_at, updated_at,
    partner, cabinets_count, pay_status, auto_split
FROM src.contracts;

INSERT INTO contract_audit_log (id, contract_id, action, changes, operator, created_at)
SELECT id, contract_id, action, changes, operator, created_at FROM src.contract_audit_log;

-- ════════════════════════════════════════════════════════════
-- §6  共享表品牌分摊 + 品牌绑定（派生）
-- ════════════════════════════════════════════════════════════
INSERT INTO meter_shared_allocations (
    id, meter_id, month_period, brand_id, entity_id,
    input_mode, collect_amount, collect_kwh, unit_price, rent_share, cabinet_count,
    meter_kwh, reading_start_date, reading_end_date, data_source, remark, created_at, updated_at, address
)
SELECT
    a.id, a.meter_id, a.month_period, a.brand_id, a.entity_id,
    'amount', a.collect_amount, NULL, a.unit_price, NULL, a.cabinet_count,
    -- 整表读数快照：口径 = 人工值优先（COALESCE(actual_kwh, kwh × 倍数)）
    (SELECT COALESCE(r.actual_kwh, r.kwh * COALESCE(r.transformer_ratio_snapshot, 1))
       FROM meter_readings r WHERE r.meter_id = a.meter_id AND r.period = a.month_period),
    NULL, NULL, 'manual', a.remark, a.created_at, a.updated_at, a.address
FROM src.meter_shared_allocations a
JOIN meters m ON m.id = a.meter_id AND m.is_shared = TRUE
ORDER BY a.id;

-- ★ 品牌绑定清单：由历史分摊行推导（只给真正的共享表建绑定）
INSERT INTO meter_shared_brand_bindings (meter_id, brand_id, start_period, end_period, remark, data_source)
SELECT a.meter_id, a.brand_id, MIN(a.month_period), NULL,
       '由历史分摊行推导（迁移生成）', 'manual'
FROM src.meter_shared_allocations a
JOIN meters m ON m.id = a.meter_id AND m.is_shared = TRUE
GROUP BY a.meter_id, a.brand_id;

-- ════════════════════════════════════════════════════════════
-- §7  审批流程配置（配置类，非交易数据）
-- ════════════════════════════════════════════════════════════
INSERT INTO approval_flows (id, biz_type, nodes, updated_at)
SELECT id, biz_type, nodes, updated_at FROM src.approval_flows;

-- ════════════════════════════════════════════════════════════
-- §7.5  派生数据预填（可重复生成；财务可在页面上覆盖）
-- ════════════════════════════════════════════════════════════
-- (1) 柜数月度快照
--     迁移来的柜子没有进/离场日期（历史无法还原）⇒ 一律按"长期存在"计入
INSERT INTO cabinet_monthly_snapshot
       (period, landlord_id, meter_id, brand_id, cabinet_count, source, remark)
SELECT p.period, m.landlord_id, c.meter_id, c.brand_id, COUNT(*), 'auto',
       '迁移预填：柜子无进/离场日期，按长期存在计入'
FROM (SELECT DISTINCT period FROM meter_readings) p
JOIN meters   m ON m.landlord_id IS NOT NULL
JOIN cabinets c ON c.meter_id = m.id
GROUP BY p.period, m.landlord_id, c.meter_id, c.brand_id
ON CONFLICT DO NOTHING;

-- (2) 场地级月度电费（损耗的载体）
--     参考电量 = Σ该场地所有表的实际用电量；最终电量默认 = 参考值（loss=0），财务可覆盖
INSERT INTO landlord_monthly_elec
       (landlord_id, period, ref_kwh, final_kwh, final_amount, unit_price,
        loss_kwh, loss_amount, data_source, remark)
SELECT
    r.landlord_id, r.period,
    ROUND(r.sum_kwh, 2), ROUND(r.sum_kwh, 2), NULL, c.electricity_price,
    0, 0, 'auto',
    '迁移预填：最终值默认等于参考值（财务可在页面覆盖）'
FROM (
    SELECT m.landlord_id, rd.period,
           SUM(COALESCE(rd.actual_kwh, rd.kwh * COALESCE(rd.transformer_ratio_snapshot, 1))) AS sum_kwh
    FROM meter_readings rd
    JOIN meters m ON m.id = rd.meter_id
    WHERE m.landlord_id IS NOT NULL
    GROUP BY m.landlord_id, rd.period
) r
LEFT JOIN LATERAL (
    SELECT c2.electricity_price
    FROM contracts c2
    WHERE c2.landlord_id = r.landlord_id
      AND c2.contract_type = '场地合同'
      AND c2.electricity_price IS NOT NULL
      AND (c2.start_date IS NULL OR c2.start_date <= (DATE(r.period || '01') + INTERVAL '1 month' - INTERVAL '1 day'))
      AND (COALESCE(c2.early_end_date, c2.end_date) IS NULL
           OR COALESCE(c2.early_end_date, c2.end_date) >= DATE(r.period || '01'))
    ORDER BY c2.id
    LIMIT 1
) c ON TRUE;

-- ════════════════════════════════════════════════════════════
-- §8  序列复位（因为插入了显式 id）
-- ════════════════════════════════════════════════════════════
-- 逐表复位序列（动态 SQL：因为插入了显式 id）
DO $$
DECLARE t text; mx bigint;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'brands','entities','landlords','landlord_owners','shareholders','introducers',
        'entity_brands','platform_users','meters','cabinets','meter_entity_changes',
        'third_party_configs','meter_devices','meter_status_cache','meter_readings',
        'meter_daily','meter_hourly','meter_yearly','meter_warnings_cache','sync_logs',
        'contracts','contract_audit_log','meter_shared_allocations','meter_shared_brand_bindings',
        'approval_flows'
    ]
    LOOP
        EXECUTE format('SELECT COALESCE(MAX(id), 0) FROM %I', t) INTO mx;
        IF mx > 0 THEN
            PERFORM setval(pg_get_serial_sequence(t, 'id'), mx, true);
        END IF;
    END LOOP;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════
-- §9  迁移后核对
-- ════════════════════════════════════════════════════════════
SELECT 'meters' t, count(*) n FROM meters
UNION ALL SELECT 'meters_active', count(*) FROM meters WHERE status='active'
UNION ALL SELECT 'meters_shared', count(*) FROM meters WHERE is_shared
UNION ALL SELECT 'meters_no_landlord', count(*) FROM meters WHERE landlord_id IS NULL
UNION ALL SELECT 'cabinets', count(*) FROM cabinets
UNION ALL SELECT 'readings', count(*) FROM meter_readings
UNION ALL SELECT 'readings_manual_actual', count(*) FROM meter_readings WHERE actual_kwh IS NOT NULL
UNION ALL SELECT 'meters_with_readings', count(DISTINCT meter_id) FROM meter_readings
UNION ALL SELECT 'contracts', count(*) FROM contracts
UNION ALL SELECT 'shared_allocations', count(*) FROM meter_shared_allocations
UNION ALL SELECT 'shared_bindings', count(*) FROM meter_shared_brand_bindings
UNION ALL SELECT 'meter_devices', count(*) FROM meter_devices
UNION ALL SELECT 'devices_linked_to_meter', count(*) FROM meter_devices WHERE meter_id IS NOT NULL
UNION ALL SELECT 'landlords', count(*) FROM landlords
UNION ALL SELECT 'brands', count(*) FROM brands
UNION ALL SELECT 'entities', count(*) FROM entities
UNION ALL SELECT 'cabinets_no_brand', count(*) FROM cabinets WHERE brand_id IS NULL
ORDER BY 1;

-- 被舍弃的孤儿读数（对应不到电表；这些设备尚未建档）
SELECT 'orphan_readings_skipped' AS item, count(*) AS n
FROM src.meter_monthly mm
WHERE NOT EXISTS (SELECT 1 FROM meters m WHERE m.meter_no = mm.address);

-- ════════════════════════════════════════════════════════════
-- §9.5  待人工处理清单
-- ════════════════════════════════════════════════════════════
SELECT '共用表未绑定品牌(需人工绑)' AS item, count(*) AS n
  FROM meters mt WHERE mt.is_shared
   AND NOT EXISTS (SELECT 1 FROM meter_shared_brand_bindings b WHERE b.meter_id = mt.id)
UNION ALL SELECT '电表无场地归属(需人工归位)', count(*) FROM meters WHERE landlord_id IS NULL
UNION ALL SELECT '读数被舍弃(设备未建档)', count(*) FROM src.meter_monthly mm
   WHERE NOT EXISTS (SELECT 1 FROM meters m WHERE m.meter_no = mm.address)
UNION ALL SELECT '分摊行缺单价(需补或绑合同)', count(*) FROM meter_shared_allocations WHERE unit_price IS NULL
UNION ALL SELECT '分摊行缺分摊租金', count(*) FROM meter_shared_allocations WHERE rent_share IS NULL
UNION ALL SELECT '柜子缺进/离场日期', count(*) FROM cabinets WHERE installed_at IS NULL
UNION ALL SELECT '柜数快照行(预填)', count(*) FROM cabinet_monthly_snapshot
UNION ALL SELECT '场地级月度电费行(预填)', count(*) FROM landlord_monthly_elec
ORDER BY 1;

-- ════════════════════════════════════════════════════════════
-- §10  清理跨库挂载（脚本仍可重复执行：开头会重建）
-- ════════════════════════════════════════════════════════════
DROP SCHEMA IF EXISTS src CASCADE;
DROP SERVER IF EXISTS src CASCADE;
