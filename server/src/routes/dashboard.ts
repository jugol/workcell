import { Router } from "express";
import type { Db } from "@workcell/db";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  router.get("/companies/:companyId/dashboard/settlement", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const startIso =
      typeof req.query.start === "string"
        ? req.query.start
        : getUtcMonthStart(new Date()).toISOString();
    const endIso =
      typeof req.query.end === "string" ? req.query.end : new Date().toISOString();
    const label = typeof req.query.label === "string" ? req.query.label : "This month";

    const report = await svc.settlement(companyId, { startIso, endIso, label });
    res.json(report);
  });

  return router;
}
