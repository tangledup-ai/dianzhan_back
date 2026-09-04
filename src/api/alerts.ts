import client from "./client";

// 预警配置（电量同比阈值 + 合同到期提前天数）
export const getAlertConfig = () =>
  client.get("/alerts/config").then(r => r.data);

export const saveAlertConfig = (data: { elecYoyRatio?: number; expireDaysVenue?: number; expireDaysBrand?: number }) =>
  client.put("/alerts/config", data).then(r => r.data);

// 预警聚合（电量异常 + 合同应收应付）
// granularity: daily=近N天日均 vs 前7天日均；monthly=本月 vs 去年同月
export const getAlerts = (params?: { granularity?: "daily" | "monthly"; days?: number }) =>
  client.get("/alerts", { params }).then(r => r.data);

// 标记某合同的预警为「已处理」：记录当时的预警特征，特征未变化前不再提醒
export const handleContractAlert = (contractId: number) =>
  client.post(`/alerts/contracts/${contractId}/handle`).then(r => r.data);
