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
