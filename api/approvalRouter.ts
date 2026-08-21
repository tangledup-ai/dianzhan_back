import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import * as A from "./queries/approval";

export const approvalRouter = createRouter({
  bizTypes: publicQuery.query(() => A.BIZ_TYPES),
  flows: publicQuery.query(() => A.listFlows()),
  saveFlow: publicQuery
    .input(z.object({
      bizType: z.string().min(1),
      nodes: z.array(z.object({
        name: z.string().min(1),
        approver: z.string().min(1),
        timeoutHours: z.number().nullish(),
      })).min(1),
    }))
    .mutation(({ input }) => A.saveFlow(input.bizType, input.nodes)),

  create: publicQuery
    .input(z.object({
      bizType: z.string().min(1),
      title: z.string().min(1, "请填写审批事由"),
      reason: z.string().nullish(),
      amount: z.number().nullish(),
      applicant: z.string().min(1, "请填写申请人"),
      attachments: z.array(z.object({ name: z.string(), size: z.number().optional() })).default([]),
    }))
    .mutation(({ input }) => A.createRequest(input)),

  list: publicQuery
    .input(z.object({
      bizType: z.string().optional(), status: z.string().optional(),
      applicant: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(),
    }).optional())
    .query(({ input }) => A.listRequests(input)),

  detail: publicQuery.input(z.object({ id: z.number() })).query(({ input }) => A.getRequest(input.id)),

  act: publicQuery
    .input(z.object({
      requestId: z.number(),
      action: z.enum(["通过", "驳回", "转办", "加签", "催办"]),
      approver: z.string().min(1),
      comment: z.string().nullish(),
      targetApprover: z.string().optional(),
      extraNode: z.object({ name: z.string(), approver: z.string() }).optional(),
    }))
    .mutation(({ input }) => A.actOnRequest(input)),

  stats: publicQuery.query(() => A.approvalStats()),
});
