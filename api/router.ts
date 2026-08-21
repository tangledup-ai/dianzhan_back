import { createRouter, publicQuery } from "./middleware";
import { ledgerRouter } from "./ledgerRouter";
import { mutationRouter } from "./mutationRouter";
import { approvalRouter } from "./approvalRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  ledger: ledgerRouter,
  mut: mutationRouter,
  approval: approvalRouter,
});

export type AppRouter = typeof appRouter;
