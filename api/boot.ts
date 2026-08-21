import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});

// ─── 小程序专用 REST 接口（纯 JSON，无 superjson）───
const MP_TOKEN = process.env.MP_API_TOKEN || "BWT-MP-2026";

app.get("/api/mp/ping", (c) => c.json({ ok: true, ts: Date.now() }));

app.get("/api/mp/approvals", async (c) => {
  if (c.req.query("token") !== MP_TOKEN) return c.json({ error: "token 无效" }, 401);
  const { listRequests } = await import("./queries/approval");
  const status = c.req.query("status") || undefined;
  const list = await listRequests({ status });
  return c.json({ list });
});

app.get("/api/mp/approvals/:id", async (c) => {
  if (c.req.query("token") !== MP_TOKEN) return c.json({ error: "token 无效" }, 401);
  const { getRequest } = await import("./queries/approval");
  const detail = await getRequest(Number(c.req.param("id")));
  if (!detail) return c.json({ error: "审批单不存在" }, 404);
  return c.json(detail);
});

app.post("/api/mp/approvals/:id/action", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  if (body.token !== MP_TOKEN) return c.json({ error: "token 无效" }, 401);
  const { actOnRequest } = await import("./queries/approval");
  try {
    const result = await actOnRequest({
      requestId: Number(c.req.param("id")),
      action: body.action as "通过" | "驳回",
      approver: String(body.approver || "陈总"),
      comment: (body.comment as string) || null,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "操作失败" }, 400);
  }
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
