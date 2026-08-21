import { drizzle } from "drizzle-orm/mysql2";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>>;
let _mockMode: boolean | null = null;

export function isMockMode() {
  if (_mockMode === null) {
    // 如果 DATABASE_URL 是占位值或未配置，启用 mock 模式
    const url = env.databaseUrl || "";
    _mockMode = !url || url.includes("root:root@localhost") || url.includes("user:pass@");
  }
  return _mockMode;
}

export function getDb() {
  if (!instance) {
    instance = drizzle(env.databaseUrl, {
      mode: "planetscale",
      schema: fullSchema,
    });
  }
  return instance;
}
