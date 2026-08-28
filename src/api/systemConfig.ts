import client from "./client";

export interface SystemConfig {
  /** DeepSeek API Key（小程序 AI 对话） */
  deepseekApiKey: string;
  /** 腾讯地图 key（地图组件） */
  mapKey: string;
}

export async function fetchSystemConfig(): Promise<SystemConfig> {
  const resp = await client.get<SystemConfig>("/system-config");
  return resp.data;
}

export async function updateSystemConfig(data: Partial<SystemConfig>): Promise<void> {
  await client.put("/system-config", data);
}

// ── 地图 key（MapPicker / StationMap 共用）────────────────────
// 后端「系统设置」未配置时回落到打包内置的默认 key
const FALLBACK_MAP_KEY = "VS3BZ-TIXCV-RJ2PQ-5YUEE-UZDEV-MHFQD";

let mapKeyCache = "";

export async function loadMapKey(): Promise<string> {
  if (mapKeyCache) return mapKeyCache;
  try {
    const cfg = await fetchSystemConfig();
    mapKeyCache = (cfg.mapKey || "").trim() || FALLBACK_MAP_KEY;
  } catch {
    mapKeyCache = FALLBACK_MAP_KEY;
  }
  return mapKeyCache;
}
