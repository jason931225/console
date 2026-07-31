-- Force-removing an organization that has equipment maintenance history fails.
--
-- THIS IS A PRODUCTION DEFECT, not a test defect. It was found by wiring a test
-- that had never executed: workorder/adapter-postgres use_cases.rs, dark until
-- 2026-07-31, fails with
--
--   23001  update or delete on table "equipment_cost_ledger" violates foreign key
--          constraint "equipment_maintenance_history_costs_ledger_same_org_fk"
--
-- WHY. `platform_force_remove_organization` (0196:189-192) sets the force GUC and
-- then calls the catalog-driven closure `platform_force_remove_direct_org_children`
-- BEFORE its hand-ordered deletes at 0196:228-231. That closure sweeps every table
-- holding a single-column `org_id` FK to `organizations` with
-- `confdeltype IN ('a','r')` (0196:129-144), and `equipment_cost_ledger` matches:
-- `equipment_cost_ledger_org_fk ... ON DELETE RESTRICT` (0034:85).
--
-- Its children are invisible to that same closure, by two independent filters:
--   * `equipment_maintenance_history_costs` reaches the ledger through the COMPOSITE
--     FK `(equipment_cost_ledger_id, org_id)` (0193), and the closure requires
--     `cardinality(fk.conkey) = 1`.
--   * `equipment_maintenance_history` is `org_id ... ON DELETE CASCADE` (0193:19),
--     and the closure admits only `'a'` and `'r'`.
--
-- So the closure deletes the parent while the children still reference it. The
-- hand-ordered block at 0196:228-231 already sequences this correctly —
-- costs, then evidence, then history, then the ledger — it simply never gets the
-- chance, because the closure has already tried and raised.
--
-- THE FIX is to name `equipment_cost_ledger` as what it already is: a root with
-- specialized ordering, exactly like the five roots 0196 already excludes for the
-- same reason. Excluding it hands the table back to the hand-ordered block that was
-- always meant to own it. Nothing is left undeleted — 0196:231 still deletes it, and
-- the child-first order there is unchanged.
--
-- Rejected alternative: moving the three maintenance-history deletes above the
-- closure call. That also works, but it copies a 160-line function body to reorder
-- four statements, and it leaves `equipment_cost_ledger` in a sweep whose ordering
-- guarantees it does not satisfy — the next composite-FK child added to the ledger
-- would reintroduce this exact failure. Excluding the root fixes the class.

CREATE OR REPLACE FUNCTION platform_force_remove_direct_org_children(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT child_ns.nspname AS schema_name, child.relname AS relation_name
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS child ON child.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_catalog.pg_class AS parent ON parent.oid = fk.confrelid
        JOIN pg_catalog.pg_namespace AS parent_ns ON parent_ns.oid = parent.relnamespace
        JOIN pg_catalog.pg_attribute AS child_attr
          ON child_attr.attrelid = child.oid
         AND child_attr.attnum = fk.conkey[1]
         AND NOT child_attr.attisdropped
        WHERE fk.contype = 'f'
          AND fk.confdeltype IN ('a', 'r')
          AND parent_ns.nspname = 'public'
          AND parent.relname = 'organizations'
          AND child_ns.nspname = 'public'
          AND child.relkind IN ('r', 'p')
          -- These roots have specialized ordering: the audit ledger must be
          -- re-homed, and employee/user/branch/region references are released
          -- only after their direct children have been closed by this pass.
          --
          -- equipment_cost_ledger joins them for the same reason and was missing:
          -- its children reach it by COMPOSITE FK and are therefore invisible to
          -- this catalog sweep, so deleting it here raises 23001 before the
          -- hand-ordered child-first block below can run.
          AND child.relname NOT IN (
              'audit_events', 'employees', 'users', 'branches', 'regions',
              -- The 0193 equipment-maintenance family. Every table below is the target of a
              -- COMPOSITE RESTRICT foreign key from a 0193 child, and `cardinality(fk.conkey) = 1`
              -- below makes those children structurally invisible to this sweep — so deleting any
              -- of these here raises 23001 while its children still reference it. All five are
              -- already deleted, child-first, by the hand-ordered block in 0196, which is where
              -- they belong. Naming the whole family rather than the one member that happened to
              -- fail first: fixing `equipment_cost_ledger` alone simply moved the failure to
              -- `evidence_media` on the next run.
              'equipment_cost_ledger', 'evidence_media',
              'equipment_maintenance_history', 'registry_equipment', 'work_orders'
          )
          AND cardinality(fk.conkey) = 1
          AND child_attr.attname = 'org_id'
        -- New tenant-facing tables normally reference older roots.  Descending
        -- OID gives those children priority before their direct parents.
        ORDER BY child.oid DESC
    LOOP
        EXECUTE format('DELETE FROM %I.%I WHERE org_id = $1',
                       target.schema_name, target.relation_name)
            USING p_id;
    END LOOP;
END;
$$;

-- Keep the migration identity as owner, for the reason 0196 records: production
-- migrations run as console_app and isolated SQLx databases run as their own table
-- owner, so reassigning this SECURITY DEFINER would separate it from the tables it
-- must delete under FORCE RLS.
REVOKE ALL ON FUNCTION platform_force_remove_direct_org_children(UUID) FROM PUBLIC, console_rt, console_platform_force_cmd;
