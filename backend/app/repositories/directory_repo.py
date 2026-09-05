from ..infra.database import get_connection, get_dict_cursor


def ids_with_tag_meters(column: str, tag: str) -> set:
    """拥有指定类型电表的档案 id 集合（column ∈ brand_id/entity_id/landlord_id）

    用于指定电表类型范围的账号在基础档案页的品牌/主体/场地列表过滤。
    """
    if column not in ("brand_id", "entity_id", "landlord_id"):
        raise ValueError(f"非法的档案列: {column}")
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(f"SELECT DISTINCT {column} AS id FROM meters WHERE tag = %s AND {column} IS NOT NULL", (tag,))
        return {int(r["id"]) for r in cur.fetchall()}
    finally:
        cur.close()
        conn.close()


# ─── 品牌方 ─────────────────────────────────────────────────

def list_brands():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM brands ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def get_brand(brand_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM brands WHERE id = %s", (brand_id,))
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def create_brand(name: str, contact: str = None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "INSERT INTO brands (name, contact, remark) VALUES (%s, %s, %s) RETURNING *",
            (name, contact, remark)
        )
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_brand(brand_id: int, name: str = None, contact: str = None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if name is not None:
            updates.append("name = %s"); values.append(name)
        if contact is not None:
            updates.append("contact = %s"); values.append(contact)
        if remark is not None:
            updates.append("remark = %s"); values.append(remark)
        if not updates:
            return None
        values.append(brand_id)
        cur.execute(f"UPDATE brands SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_brand(brand_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 检查是否有关联数据（只检查确定存在的表）
        refs = []
        check_tables = ["meters", "contracts", "rent_incomes"]
        for table in check_tables:
            try:
                cur.execute(f"SELECT COUNT(*) as cnt FROM {table} WHERE brand_id = %s", (brand_id,))
                cnt = cur.fetchone()["cnt"]
                if cnt > 0:
                    refs.append(f"{table}({cnt}条)")
            except Exception:
                conn.rollback()  # 回滚失败的事务，否则后续SQL会报错
                pass  # 表不存在则跳过
        if refs:
            raise ValueError(f"该品牌被以下数据引用，无法删除：{', '.join(refs)}")

        cur.execute("DELETE FROM brands WHERE id = %s", (brand_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()


# ─── 公司主体 ───────────────────────────────────────────────

def list_entities():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM entities ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


ENTITY_ARCHIVE_FIELDS = ("tax_no", "taxpayer_type", "invoice_bank", "invoice_account",
                         "invoice_address", "invoice_phone", "status", "sort")


def create_entity(name: str, short_name: str = None, remark: str = None, **archive):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cols = ["name", "short_name", "remark"]
        vals = [name, short_name, remark]
        for f in ENTITY_ARCHIVE_FIELDS:
            if f in archive:
                cols.append(f); vals.append(archive[f])
        cur.execute(
            f"INSERT INTO entities ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) RETURNING *",
            vals
        )
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_entity(entity_id: int, name: str = None, short_name: str = None, remark: str = None, **archive):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if name is not None:
            updates.append("name = %s"); values.append(name)
        if short_name is not None:
            updates.append("short_name = %s"); values.append(short_name)
        if remark is not None:
            updates.append("remark = %s"); values.append(remark)
        for f in ENTITY_ARCHIVE_FIELDS:
            if f in archive:
                updates.append(f"{f} = %s"); values.append(archive[f])
        if not updates:
            return None
        values.append(entity_id)
        cur.execute(f"UPDATE entities SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_entity(entity_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 引用检查：合同/电表仍挂在主体上时拒绝删除（级联会连带毁掉电表的抄表记录与柜子数据）
        cur.execute("SELECT name FROM entities WHERE id = %s", (entity_id,))
        entity = cur.fetchone()
        if not entity:
            return False
        cur.execute("SELECT count(*) AS n FROM contracts WHERE entity_id = %s", (entity_id,))
        contract_n = cur.fetchone()["n"]
        cur.execute("SELECT count(*) AS n FROM meters WHERE entity_id = %s", (entity_id,))
        meter_n = cur.fetchone()["n"]
        if contract_n or meter_n:
            raise ValueError(
                f"无法删除「{entity['name']}」：仍有 {contract_n} 份合同、{meter_n} 块电表关联到该主体，"
                "请先在合同/电表中修改或删除这些关联后再删除"
            )
        # 品牌授权关联是纯关联表，随主体一并删除
        cur.execute("DELETE FROM entity_brands WHERE entity_id = %s", (entity_id,))
        cur.execute("DELETE FROM entities WHERE id = %s", (entity_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()


# ─── 场地方 ─────────────────────────────────────────────────

def list_landlords():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        # 场地 = 聚合根：公共属性（landlords 自身）+ 汇总（landlord_site_summary 视图实时聚合）
        cur.execute("""
            SELECT l.*,
                   s.site_rent_cost, s.brand_rent_income,
                   s.site_contract_count, s.brand_contract_count,
                   s.site_contract_ids, s.brand_contract_ids
            FROM landlords l
            LEFT JOIN landlord_site_summary s ON s.landlord_id = l.id
            ORDER BY l.id
        """)
        rows = cur.fetchall()

        # 多业主子表：按场地方聚合（最新的在前）
        cur.execute("""
            SELECT * FROM landlord_owners
            ORDER BY landlord_id, start_date DESC NULLS LAST, id DESC
        """)
        owners_by_landlord = {}
        for o in cur.fetchall():
            owners_by_landlord.setdefault(o["landlord_id"], []).append(o)
        for r in rows:
            r["owners"] = owners_by_landlord.get(r["id"], [])
        return rows
    finally:
        cur.close()
        conn.close()


def _sync_current_owner(cur, landlord_id: int):
    """把 landlord_owners 最新一条业主同步到 landlords.contact（当前业主冗余）"""
    cur.execute("""
        SELECT owner_name FROM landlord_owners
        WHERE landlord_id = %s
        ORDER BY start_date DESC NULLS LAST, id DESC
        LIMIT 1
    """, (landlord_id,))
    row = cur.fetchone()
    cur.execute("UPDATE landlords SET contact = %s WHERE id = %s",
                (row["owner_name"] if row else None, landlord_id))


def add_landlord_owner(landlord_id: int, owner_name: str, phone: str = None,
                       start_date=None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO landlord_owners (landlord_id, owner_name, phone, start_date, remark)
            VALUES (%s, %s, %s, %s, %s) RETURNING *
        """, (landlord_id, owner_name, phone, start_date, remark))
        owner = cur.fetchone()
        _sync_current_owner(cur, landlord_id)
        conn.commit()
        return owner
    finally:
        cur.close()
        conn.close()


def update_landlord_owner(owner_id: int, owner_name: str, phone: str = None,
                          start_date=None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            UPDATE landlord_owners
            SET owner_name = %s, phone = %s, start_date = %s, remark = %s
            WHERE id = %s RETURNING *
        """, (owner_name, phone, start_date, remark, owner_id))
        owner = cur.fetchone()
        if owner:
            _sync_current_owner(cur, owner["landlord_id"])
        conn.commit()
        return owner
    finally:
        cur.close()
        conn.close()


def delete_landlord_owner(owner_id: int):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT landlord_id FROM landlord_owners WHERE id = %s", (owner_id,))
        row = cur.fetchone()
        if not row:
            return False
        cur.execute("DELETE FROM landlord_owners WHERE id = %s", (owner_id,))
        _sync_current_owner(cur, row["landlord_id"])
        conn.commit()
        return True
    finally:
        cur.close()
        conn.close()


def ensure_landlord_owner(landlord_id: int, owner_name: str, phone: str = None):
    """幂等：场地方下不存在同名业主时补一条（合同 Excel 导入用）"""
    if not owner_name:
        return None
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT id FROM landlord_owners WHERE landlord_id = %s AND owner_name = %s
        """, (landlord_id, owner_name))
        row = cur.fetchone()
        if row:
            return row["id"]
        cur.execute("""
            INSERT INTO landlord_owners (landlord_id, owner_name, phone)
            VALUES (%s, %s, %s) RETURNING *
        """, (landlord_id, owner_name, phone))
        owner = cur.fetchone()
        _sync_current_owner(cur, landlord_id)
        conn.commit()
        return owner
    finally:
        cur.close()
        conn.close()


def create_landlord(name: str, contact: str = None, phone: str = None, remark: str = None,
                    region: str = None, address: str = None, latitude=None, longitude=None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "INSERT INTO landlords (name, contact, phone, region, address, latitude, longitude, remark) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
            (name, contact, phone, region, address, latitude, longitude, remark)
        )
        row = cur.fetchone()
        # 初始业主：联系人非空时登记为首任业主
        if contact:
            cur.execute(
                "INSERT INTO landlord_owners (landlord_id, owner_name, phone) VALUES (%s, %s, %s)",
                (row["id"], contact, phone)
            )
        conn.commit()
        return row
    finally:
        cur.close()
        conn.close()


def update_landlord(landlord_id: int, name: str = None, contact: str = None, phone: str = None, remark: str = None,
                    region: str = None, address: str = None, latitude=None, longitude=None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if name is not None:
            updates.append("name = %s"); values.append(name)
        if contact is not None:
            updates.append("contact = %s"); values.append(contact)
        if phone is not None:
            updates.append("phone = %s"); values.append(phone)
        if region is not None:
            updates.append("region = %s"); values.append(region)
        if address is not None:
            updates.append("address = %s"); values.append(address)
        if latitude is not None:
            updates.append("latitude = %s"); values.append(latitude)
        if longitude is not None:
            updates.append("longitude = %s"); values.append(longitude)
        if remark is not None:
            updates.append("remark = %s"); values.append(remark)
        if not updates:
            return None
        values.append(landlord_id)
        cur.execute(f"UPDATE landlords SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        updated = cur.fetchone()
        # v3：contracts.station_name 冗余快照列已删除，landlord 改名无需同步
        # 直接编辑「当前业主」（联系人）→ 同步改名最新的业主记录，保持业主表为唯一出处
        if contact is not None:
            cur.execute("""
                SELECT id FROM landlord_owners
                WHERE landlord_id = %s
                ORDER BY start_date DESC NULLS LAST, id DESC
                LIMIT 1
            """, (landlord_id,))
            latest = cur.fetchone()
            if latest:
                cur.execute("UPDATE landlord_owners SET owner_name = %s WHERE id = %s", (contact, latest["id"]))
        conn.commit()
        return updated
    finally:
        cur.close()
        conn.close()


def delete_landlord(landlord_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM landlords WHERE id = %s", (landlord_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()


# ─── 股东 ───────────────────────────────────────────────────

def list_shareholders():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM shareholders ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_shareholder(name: str, phone: str = None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "INSERT INTO shareholders (name, phone, remark) VALUES (%s, %s, %s) RETURNING *",
            (name, phone, remark)
        )
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_shareholder(shareholder_id: int, name: str = None, phone: str = None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if name is not None:
            updates.append("name = %s"); values.append(name)
        if phone is not None:
            updates.append("phone = %s"); values.append(phone)
        if remark is not None:
            updates.append("remark = %s"); values.append(remark)
        if not updates:
            return None
        values.append(shareholder_id)
        cur.execute(f"UPDATE shareholders SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_shareholder(shareholder_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM shareholders WHERE id = %s", (shareholder_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()


# ─── 介绍人 ─────────────────────────────────────────────────

def list_introducers():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM introducers ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_introducer(name: str, phone: str = None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute(
            "INSERT INTO introducers (name, phone, remark) VALUES (%s, %s, %s) RETURNING *",
            (name, phone, remark)
        )
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_introducer(introducer_id: int, name: str = None, phone: str = None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if name is not None:
            updates.append("name = %s"); values.append(name)
        if phone is not None:
            updates.append("phone = %s"); values.append(phone)
        if remark is not None:
            updates.append("remark = %s"); values.append(remark)
        if not updates:
            return None
        values.append(introducer_id)
        cur.execute(f"UPDATE introducers SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_introducer(introducer_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM introducers WHERE id = %s", (introducer_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()


# ─── 公司主体-品牌方关联 ─────────────────────────────────────

def list_entity_brands(entity_id: int = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        conditions, values = [], []
        if entity_id:
            conditions.append("eb.entity_id = %s"); values.append(entity_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        cur.execute(f"""
            SELECT eb.*, e.name as entity_name, e.short_name as entity_short_name,
                   b.name as brand_name
            FROM entity_brands eb
            LEFT JOIN entities e ON eb.entity_id = e.id
            LEFT JOIN brands b ON eb.brand_id = b.id
            {where}
            ORDER BY eb.entity_id, eb.brand_id
        """, values)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_entity_brand(entity_id: int, brand_id: int, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO entity_brands (entity_id, brand_id, remark)
            VALUES (%s, %s, %s)
            RETURNING *
        """, (entity_id, brand_id, remark))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_entity_brand(id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM entity_brands WHERE id = %s", (id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()


# ─── 平台使用人员 ────────────────────────────────────────────

def list_platform_users():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            SELECT pu.*, s.name as shareholder_name
            FROM platform_users pu
            LEFT JOIN shareholders s ON pu.shareholder_id = s.id
            ORDER BY pu.id
        """)
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


# update_platform_user 的「未提供」哨兵：区分「不改动」与「显式清空」
_UNSET = object()


def create_platform_user(name: str, role: str, shareholder_id: int = None, phone: str = None, remark: str = None,
                         password: str = None, landlord_ids: list = None, meter_tag_scope: str = None):
    from ..infra.password import hash_password
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        pwd = hash_password(password) if password else None
        cur.execute(
            "INSERT INTO platform_users (name, role, shareholder_id, password, landlord_ids, meter_tag_scope, phone, remark) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *",
            (name, role, shareholder_id, pwd, landlord_ids, meter_tag_scope, phone, remark)
        )
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_platform_user(user_id: int, name: str = None, role: str = None, shareholder_id: int = None, phone: str = None,
                         remark: str = None, password: str = None, landlord_ids: list = None,
                         meter_tag_scope=_UNSET):
    from ..infra.password import hash_password
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if name is not None:
            updates.append("name = %s"); values.append(name)
        if role is not None:
            updates.append("role = %s"); values.append(role)
        if shareholder_id is not None:
            updates.append("shareholder_id = %s"); values.append(shareholder_id)
        if phone is not None:
            updates.append("phone = %s"); values.append(phone)
        if password:
            updates.append("password = %s"); values.append(hash_password(password))
        if landlord_ids is not None:
            updates.append("landlord_ids = %s"); values.append(landlord_ids)
        if meter_tag_scope is not _UNSET:
            updates.append("meter_tag_scope = %s"); values.append(meter_tag_scope)
        if remark is not None:
            updates.append("remark = %s"); values.append(remark)
        if not updates:
            return None
        values.append(user_id)
        cur.execute(f"UPDATE platform_users SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_platform_user(user_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM platform_users WHERE id = %s", (user_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()


# ─── 第三方接口配置 ───────────────────────────────────────────

def list_third_party_configs():
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("SELECT * FROM third_party_configs ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()


def create_third_party_config(name: str, base_url: str, auth_code: str, meter_tag: str = "合作商电表", remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        cur.execute("""
            INSERT INTO third_party_configs (name, base_url, auth_code, meter_tag, remark)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
        """, (name, base_url, auth_code, meter_tag, remark))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def update_third_party_config(config_id: int, name: str = None, base_url: str = None, auth_code: str = None, meter_tag: str = None, remark: str = None):
    conn = get_connection()
    cur = get_dict_cursor(conn)
    try:
        updates, values = [], []
        if name is not None:
            updates.append("name = %s"); values.append(name)
        if base_url is not None:
            updates.append("base_url = %s"); values.append(base_url)
        if auth_code is not None:
            updates.append("auth_code = %s"); values.append(auth_code)
        if meter_tag is not None:
            updates.append("meter_tag = %s"); values.append(meter_tag)
        if remark is not None:
            updates.append("remark = %s"); values.append(remark)
        if not updates:
            return None
        values.append(config_id)
        cur.execute(f"UPDATE third_party_configs SET {', '.join(updates)} WHERE id = %s RETURNING *", values)
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()


def delete_third_party_config(config_id: int):
    conn = get_connection()
    cur = conn.cursor()
    try:
        # 删除前把关联设备置空，避免外键约束报错
        cur.execute("UPDATE meter_devices SET config_id = NULL WHERE config_id = %s", (config_id,))
        cur.execute("DELETE FROM third_party_configs WHERE id = %s", (config_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        cur.close()
        conn.close()
