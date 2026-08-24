-- Tenant isolation, for the same reason every module table has it: a bug in the gateway's access
-- check should not be the only thing standing between one workspace's prose and another's. Until
-- this migration the table was read and written on the privileged pool with no policy at all.
--
-- `create policy` has no `if not exists`, and this runs against schemas that may already carry it,
-- so drop first. `force` matters because the table owner would otherwise bypass the policy, and the
-- owner is the role the service connects as.
ALTER TABLE "kern_collab"."documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kern_collab"."documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "documents_ws_isolation" ON "kern_collab"."documents";--> statement-breakpoint
CREATE POLICY "documents_ws_isolation" ON "kern_collab"."documents"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
