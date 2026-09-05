import psycopg2
import psycopg2.extras
from ..config import DATABASE_URL


def get_connection():
    """获取数据库连接"""
    return psycopg2.connect(DATABASE_URL)


def get_dict_cursor(conn):
    """获取字典游标"""
    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)


def init_database():
    """初始化数据库表"""
    conn = get_connection()
    cur = conn.cursor()
    try:
        import os
        sql_file = os.path.join(os.path.dirname(__file__), '..', 'database_init.sql')
        with open(sql_file, 'r', encoding='utf-8') as f:
            cur.execute(f.read())
        conn.commit()
        print("✅ 数据库表初始化完成")
    except Exception as e:
        print(f"❌ 数据库初始化失败: {e}")
        conn.rollback()
    finally:
        cur.close()
        conn.close()
    # 存量库结构同步：逐条执行、单条失败不影响其余（老库升级自动补列）
    sync_schema()


def _split_sql_statements(sql: str) -> list:
    """按分号切分 SQL 语句，跳过 $$...$$ dollar-quote 块内的分号（DO 块/函数体）。

    行为兼容原朴素切分：纯注释/空白段丢弃；语句内的注释行保留（psycopg2 可执行）。
    """
    statements, buf, in_dollar = [], [], False
    i = 0
    n = len(sql)
    while i < n:
        if sql[i] == "$" and i + 1 < n and sql[i + 1] == "$":
            in_dollar = not in_dollar
            buf.append("$$")
            i += 2
            continue
        if sql[i] == ";" and not in_dollar:
            statements.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(sql[i])
        i += 1
    statements.append("".join(buf))
    return [s.strip() for s in statements if s.strip() and not all(
        line.strip().startswith("--") or not line.strip() for line in s.strip().splitlines()
    )]


def sync_schema():
    """执行 schema_sync.sql（纯增量幂等语句），逐条执行，失败只记日志。

    database_init.sql 是单事务整体执行：老库上任何一条失败（如 COMMENT 引用
    不存在的新列）会导致整份文件回滚，旧表永远得不到新列。这里用逐条提交
    的方式保证升级兼容。
    """
    import os
    sql_file = os.path.join(os.path.dirname(__file__), '..', 'schema_sync.sql')
    if not os.path.exists(sql_file):
        return
    with open(sql_file, 'r', encoding='utf-8') as f:
        statements = _split_sql_statements(f.read())
    conn = get_connection()
    cur = conn.cursor()
    applied = failed = 0
    try:
        for stmt in statements:
            try:
                cur.execute(stmt)
                conn.commit()
                applied += 1
            except Exception as e:
                conn.rollback()
                failed += 1
                print(f"⚠️ schema_sync 单条失败（已跳过）: {e}\n    语句: {stmt[:80]}...")
        print(f"✅ 结构同步完成: {applied} 条生效, {failed} 条失败")
    finally:
        cur.close()
        conn.close()
