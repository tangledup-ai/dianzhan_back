-- 平台人员认证与权限（RBAC）
-- 1) platform_users 增加登录密码（哈希存储）与股东关联场地（landlord_ids，仅 role=shareholder 使用）
-- 幂等：可重复执行。

ALTER TABLE platform_users
    ADD COLUMN IF NOT EXISTS password VARCHAR(200),
    ADD COLUMN IF NOT EXISTS landlord_ids INTEGER[];

CREATE INDEX IF NOT EXISTS idx_platform_users_name ON platform_users(name);
