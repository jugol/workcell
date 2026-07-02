-- "전체 앱 기획" — per-screen form factor hint (mobile|tablet|desktop) so the flow
-- renders each node at its true size/aspect (a wide desktop/admin screen no longer
-- shares the same portrait frame as a phone screen). Nullable → defaults to mobile
-- at the render layer. IF NOT EXISTS so a manual pre-apply + the migration are both
-- safe.
ALTER TABLE "issue_work_products" ADD COLUMN IF NOT EXISTS "form_factor" text;
