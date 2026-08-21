import { eq, desc } from "drizzle-orm";
import { getDb, isMockMode } from "./connection";
import { approvalFlows, approvalRequests, approvalRecords } from "@db/schema";
import * as mock from "./mock";

export interface FlowNode {
  name: string;
  approver: string;
  timeoutHours?: number | null;
}

const DEFAULT_FLOWS: Record<string, FlowNode[]> = {
  电费付款: [
    { name: "经办人", approver: "经办人" },
    { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 },
    { name: "总经理审批", approver: "陈总", timeoutHours: 48 },
    { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 },
  ],
  租金付款: [
    { name: "经办人", approver: "经办人" },
    { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 },
    { name: "总经理审批", approver: "陈总", timeoutHours: 48 },
    { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 },
  ],
  股东分红: [
    { name: "经办人", approver: "经办人" },
    { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 },
    { name: "总经理审批", approver: "陈总", timeoutHours: 48 },
    { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 },
  ],
  费用报销: [
    { name: "经办人", approver: "经办人" },
    { name: "部门负责人", approver: "部门负责人", timeoutHours: 24 },
    { name: "总经理审批", approver: "陈总", timeoutHours: 48 },
    { name: "财务审核付款", approver: "财务负责人", timeoutHours: 24 },
  ],
  其他: [
    { name: "经办人", approver: "经办人" },
    { name: "总经理审批", approver: "陈总", timeoutHours: 48 },
  ],
};

export const BIZ_TYPES = Object.keys(DEFAULT_FLOWS);

const parseNodes = (json: string | null | undefined): FlowNode[] => {
  try { return json ? (JSON.parse(json) as FlowNode[]) : []; } catch { return []; }
};

// ─── 流程配置 ───
export async function listFlows() {
  if (isMockMode()) {
    return mock.mockApprovalFlows.map(r => ({ ...r, nodeList: parseNodes(r.nodes) }));
  }
  const db = getDb();
  let rows = await db.select().from(approvalFlows);
  if (rows.length === 0) {
    for (const [bizType, nodes] of Object.entries(DEFAULT_FLOWS)) {
      await db.insert(approvalFlows).values([{ bizType, nodes: JSON.stringify(nodes) }]);
    }
    rows = await db.select().from(approvalFlows);
  }
  const existing = new Set(rows.map((r) => r.bizType));
  for (const [bizType, nodes] of Object.entries(DEFAULT_FLOWS)) {
    if (!existing.has(bizType)) {
      await db.insert(approvalFlows).values([{ bizType, nodes: JSON.stringify(nodes) }]);
    }
  }
  rows = await db.select().from(approvalFlows);
  return rows.map((r) => ({ ...r, nodeList: parseNodes(r.nodes) }));
}

export async function saveFlow(bizType: string, nodes: FlowNode[]) {
  if (isMockMode()) return; // mock 模式下不保存
  const db = getDb();
  const [existing] = await db.select().from(approvalFlows).where(eq(approvalFlows.bizType, bizType));
  if (existing) {
    await db.update(approvalFlows).set({ nodes: JSON.stringify(nodes) }).where(eq(approvalFlows.id, existing.id));
  } else {
    await db.insert(approvalFlows).values([{ bizType, nodes: JSON.stringify(nodes) }]);
  }
}

// ─── 审批单 ───
export interface RequestView {
  id: number; bizType: string; title: string; reason: string | null;
  amount: number | null; applicant: string;
  attachments: { name: string; size?: number }[];
  flowNodes: FlowNode[]; currentNode: number; status: string;
  urgeCount: number; createdAt: Date; finishedAt: Date | null;
  currentNodeName: string | null; currentApprover: string | null;
  elapsedHours: number;
}

function toView(r: typeof approvalRequests.$inferSelect): RequestView {
  const nodes = parseNodes(r.flowNodes);
  const cur = r.status === "审批中" ? nodes[r.currentNode] : undefined;
  return {
    id: r.id, bizType: r.bizType, title: r.title, reason: r.reason,
    amount: r.amount === null ? null : Number(r.amount), applicant: r.applicant,
    attachments: (() => { try { return r.attachments ? JSON.parse(r.attachments) : []; } catch { return []; } })(),
    flowNodes: nodes, currentNode: r.currentNode, status: r.status,
    urgeCount: r.urgeCount, createdAt: r.createdAt, finishedAt: r.finishedAt,
    currentNodeName: cur?.name ?? null, currentApprover: cur?.approver ?? null,
    elapsedHours: Math.round(((Date.now() - r.createdAt.getTime()) / 3600000) * 10) / 10,
  };
}

function mockToView(r: typeof mock.mockApprovalRequests[0]): RequestView {
  const nodes = parseNodes(r.flowNodes);
  const cur = r.status === "审批中" ? nodes[r.currentNode] : undefined;
  return {
    id: r.id, bizType: r.bizType, title: r.title, reason: r.reason,
    amount: r.amount === null ? null : Number(r.amount), applicant: r.applicant,
    attachments: (() => { try { return r.attachments ? JSON.parse(r.attachments) : []; } catch { return []; } })(),
    flowNodes: nodes, currentNode: r.currentNode, status: r.status,
    urgeCount: r.urgeCount, createdAt: r.createdAt, finishedAt: r.finishedAt,
    currentNodeName: cur?.name ?? null, currentApprover: cur?.approver ?? null,
    elapsedHours: Math.round(((Date.now() - r.createdAt.getTime()) / 3600000) * 10) / 10,
  };
}

export async function createRequest(input: {
  bizType: string; title: string; reason?: string | null; amount?: number | null;
  applicant: string; attachments?: { name: string; size?: number }[];
}) {
  if (isMockMode()) {
    const nodes = DEFAULT_FLOWS[input.bizType] ?? DEFAULT_FLOWS["其他"];
    const newId = Math.max(...mock.mockApprovalRequests.map(r => r.id)) + 1;
    mock.mockApprovalRequests.push({
      id: newId, bizType: input.bizType, title: input.title, reason: input.reason ?? null,
      amount: input.amount === null || input.amount === undefined ? null : String(input.amount),
      applicant: input.applicant,
      attachments: JSON.stringify(input.attachments ?? []),
      flowNodes: JSON.stringify(nodes), currentNode: 1, status: "审批中",
      urgeCount: 0, createdAt: new Date(), finishedAt: null,
    });
    return { id: newId };
  }
  const db = getDb();
  const flows = await listFlows();
  const flow = flows.find((f) => f.bizType === input.bizType);
  const nodes = flow?.nodeList?.length ? flow.nodeList : DEFAULT_FLOWS[input.bizType] ?? DEFAULT_FLOWS["其他"];
  const [r] = await db.insert(approvalRequests).values([{
    bizType: input.bizType, title: input.title, reason: input.reason ?? null,
    amount: input.amount === null || input.amount === undefined ? null : String(input.amount),
    applicant: input.applicant,
    attachments: JSON.stringify(input.attachments ?? []),
    flowNodes: JSON.stringify(nodes), currentNode: 1, status: "审批中",
  }]).$returningId();
  await db.insert(approvalRecords).values([{
    requestId: r.id, nodeIndex: 0, nodeName: nodes[0]?.name ?? "经办人",
    approver: input.applicant, action: "提交", comment: input.reason ?? null,
  }]);
  return { id: r.id };
}

export async function listRequests(filter?: {
  bizType?: string; status?: string; applicant?: string;
  dateFrom?: string; dateTo?: string;
}) {
  if (isMockMode()) {
    return mock.mockApprovalRequests
      .filter((r) => {
        if (filter?.bizType && r.bizType !== filter.bizType) return false;
        if (filter?.status && r.status !== filter.status) return false;
        if (filter?.applicant && !r.applicant.includes(filter.applicant)) return false;
        if (filter?.dateFrom && r.createdAt < new Date(filter.dateFrom)) return false;
        if (filter?.dateTo && r.createdAt > new Date(filter.dateTo + "T23:59:59")) return false;
        return true;
      })
      .map(mockToView);
  }
  const db = getDb();
  const rows = await db.select().from(approvalRequests).orderBy(desc(approvalRequests.id));
  return rows
    .filter((r) => {
      if (filter?.bizType && r.bizType !== filter.bizType) return false;
      if (filter?.status && r.status !== filter.status) return false;
      if (filter?.applicant && !r.applicant.includes(filter.applicant)) return false;
      if (filter?.dateFrom && r.createdAt < new Date(filter.dateFrom)) return false;
      if (filter?.dateTo && r.createdAt > new Date(filter.dateTo + "T23:59:59")) return false;
      return true;
    })
    .map(toView);
}

export async function getRequest(id: number) {
  if (isMockMode()) {
    const r = mock.mockApprovalRequests.find(r => r.id === id);
    if (!r) return null;
    const records = mock.mockApprovalRecords.filter(rec => rec.requestId === id);
    return { ...mockToView(r), records: records.reverse() };
  }
  const db = getDb();
  const [r] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  if (!r) return null;
  const records = await db.select().from(approvalRecords)
    .where(eq(approvalRecords.requestId, id)).orderBy(desc(approvalRecords.id));
  return { ...toView(r), records: records.reverse() };
}

export async function actOnRequest(input: {
  requestId: number; action: "通过" | "驳回" | "转办" | "加签" | "催办";
  approver: string; comment?: string | null; targetApprover?: string;
  extraNode?: { name: string; approver: string };
}) {
  if (isMockMode()) {
    const r = mock.mockApprovalRequests.find(r => r.id === input.requestId);
    if (!r) throw new Error("审批单不存在");
    if (r.status !== "审批中") throw new Error("该审批单已办结");
    const nodes = parseNodes(r.flowNodes);

    if (input.action === "催办") {
      r.urgeCount++;
      return { ok: true };
    }

    if (input.action === "转办") {
      if (!input.targetApprover) throw new Error("请指定转办人");
      nodes[r.currentNode] = { ...nodes[r.currentNode], approver: input.targetApprover };
      r.flowNodes = JSON.stringify(nodes);
      return { ok: true };
    }

    if (input.action === "加签") {
      if (!input.extraNode?.approver) throw new Error("请指定加签人");
      nodes.splice(r.currentNode + 1, 0, { name: input.extraNode.name || "加签审批", approver: input.extraNode.approver });
      r.flowNodes = JSON.stringify(nodes);
      return { ok: true };
    }

    // 通过 / 驳回
    if (input.action === "驳回") {
      r.status = "已驳回";
      r.finishedAt = new Date();
    } else {
      const isLast = r.currentNode >= nodes.length - 1;
      if (isLast) {
        r.status = "已通过";
        r.finishedAt = new Date();
      } else {
        r.currentNode++;
      }
    }
    return { ok: true };
  }

  const db = getDb();
  const [r] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, input.requestId));
  if (!r) throw new Error("审批单不存在");
  if (r.status !== "审批中") throw new Error("该审批单已办结");
  const nodes = parseNodes(r.flowNodes);

  if (input.action === "催办") {
    await db.update(approvalRequests).set({ urgeCount: r.urgeCount + 1 }).where(eq(approvalRequests.id, r.id));
    await db.insert(approvalRecords).values([{
      requestId: r.id, nodeIndex: r.currentNode, nodeName: nodes[r.currentNode]?.name,
      approver: input.approver, action: "催办", comment: input.comment ?? null,
    }]);
    return { ok: true };
  }

  if (input.action === "转办") {
    if (!input.targetApprover) throw new Error("请指定转办人");
    nodes[r.currentNode] = { ...nodes[r.currentNode], approver: input.targetApprover };
    await db.update(approvalRequests).set({ flowNodes: JSON.stringify(nodes) }).where(eq(approvalRequests.id, r.id));
    await db.insert(approvalRecords).values([{
      requestId: r.id, nodeIndex: r.currentNode, nodeName: nodes[r.currentNode]?.name,
      approver: input.approver, action: "转办",
      comment: `转办给 ${input.targetApprover}${input.comment ? `：${input.comment}` : ""}`,
    }]);
    return { ok: true };
  }

  if (input.action === "加签") {
    if (!input.extraNode?.approver) throw new Error("请指定加签人");
    nodes.splice(r.currentNode + 1, 0, { name: input.extraNode.name || "加签审批", approver: input.extraNode.approver });
    await db.update(approvalRequests).set({ flowNodes: JSON.stringify(nodes) }).where(eq(approvalRequests.id, r.id));
    await db.insert(approvalRecords).values([{
      requestId: r.id, nodeIndex: r.currentNode, nodeName: nodes[r.currentNode]?.name,
      approver: input.approver, action: "加签",
      comment: `加签 ${input.extraNode.approver}${input.comment ? `：${input.comment}` : ""}`,
    }]);
    return { ok: true };
  }

  // 通过 / 驳回
  await db.insert(approvalRecords).values([{
    requestId: r.id, nodeIndex: r.currentNode, nodeName: nodes[r.currentNode]?.name,
    approver: input.approver, action: input.action, comment: input.comment ?? null,
  }]);
  if (input.action === "驳回") {
    await db.update(approvalRequests).set({ status: "已驳回", finishedAt: new Date() }).where(eq(approvalRequests.id, r.id));
  } else {
    const isLast = r.currentNode >= nodes.length - 1;
    if (isLast) {
      await db.update(approvalRequests).set({ status: "已通过", finishedAt: new Date() }).where(eq(approvalRequests.id, r.id));
    } else {
      await db.update(approvalRequests).set({ currentNode: r.currentNode + 1 }).where(eq(approvalRequests.id, r.id));
    }
  }
  return { ok: true };
}

export async function approvalStats() {
  const all = await listRequests();
  const pending = all.filter((r) => r.status === "审批中");
  return {
    pendingCount: pending.length,
    approvedCount: all.filter((r) => r.status === "已通过").length,
    rejectedCount: all.filter((r) => r.status === "已驳回").length,
    totalCount: all.length,
    pendingAmount: Math.round(pending.reduce((t, r) => t + (r.amount ?? 0), 0) * 100) / 100,
  };
}
