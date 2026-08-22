import client from "./client";

export const listFlows = () =>
  client.get("/approvals/flows").then(r => r.data);

export const saveFlow = (data: any) =>
  client.post("/approvals/flows", data).then(r => r.data);

export const listApprovals = (params?: { bizType?: string; status?: string; applicant?: string }) =>
  client.get("/approvals", { params }).then(r => r.data);

export const getApproval = (id: number) =>
  client.get(`/approvals/${id}`).then(r => r.data);

export const createApproval = (data: any) =>
  client.post("/approvals", data).then(r => r.data);

export const actOnApproval = (id: number, data: any) =>
  client.post(`/approvals/${id}/act`, data).then(r => r.data);

export const getApprovalStats = () =>
  client.get("/approvals/stats/overview").then(r => r.data);

// 分红审批（支持多月批量：dividendRecordIds 数组；v3：按场地 landlordName）
export const submitDividendApproval = (data: {
  dividendRecordId: number; dividendRecordIds?: number[]; landlordName: string; period: string; amount: number;
  applicant: string; approvers?: { finance_supervisor?: string; boss?: string };
}) =>
  client.post("/approvals", {
    bizType: "分红审批",
    title: `${data.landlordName} ${data.period} 分红审批`,
    applicant: data.applicant,
    amount: data.amount,
    reason: `${data.landlordName} ${data.period} 分红，金额 ${data.amount} 元`,
    dividendRecordId: data.dividendRecordId,
    dividendRecordIds: data.dividendRecordIds,
    approvers: data.approvers,
  }).then(r => r.data);

export const getApprovalByDividend = (dividendId: number) =>
  client.get(`/approvals/by-dividend/${dividendId}`).then(r => r.data);

// 站点费用审批（电费/场地费；v3：按场地 landlordId）
export interface StationApprovalData {
  landlordId: number;
  landlordName: string;
  period: string;
  approvalType: "电费付款" | "场地费付款" | "电费+场地费";
  electricityAmount?: number;
  rentAmount?: number;
  totalAmount: number;
  applicant: string;
  reason?: string;
  title?: string;
}

export const submitStationApproval = (data: StationApprovalData) =>
  client.post("/approvals", {
    bizType: data.approvalType === "电费付款" ? "电费付款" : data.approvalType === "场地费付款" ? "场地费付款" : "电费+场地费",
    title: data.title || `${data.landlordName} ${data.period} ${data.approvalType}`,
    applicant: data.applicant,
    amount: data.totalAmount,
    reason: data.reason || `${data.landlordName} ${data.period} ${data.approvalType}，金额 ${data.totalAmount} 元`,
    landlordId: data.landlordId,
    period: data.period,
    electricityAmount: data.electricityAmount,
    rentAmount: data.rentAmount,
  }).then(r => r.data);
