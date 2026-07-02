-- WC-64: capabilities + capability_assignments now cascade-delete with their
-- company. Previously their company_id FKs had no ON DELETE action (an
-- inconsistency vs labels/routines/etc., which cascade), so deleting a company
-- that owns capabilities failed with a FK violation. Since companyService.create
-- now seeds MCP-server capabilities on every company, that inconsistency
-- surfaced. A company's capabilities (and their scope assignments) are
-- meaningless without the company, so cascade is the correct semantics.
ALTER TABLE "capabilities" DROP CONSTRAINT IF EXISTS "capabilities_company_id_companies_id_fk";
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;

ALTER TABLE "capability_assignments" DROP CONSTRAINT IF EXISTS "capability_assignments_company_id_companies_id_fk";
ALTER TABLE "capability_assignments" ADD CONSTRAINT "capability_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
