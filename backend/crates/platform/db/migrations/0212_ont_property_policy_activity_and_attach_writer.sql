-- Migration 0212: field-level policy stops being an oracle and becomes enforcement.
--
-- WHAT WAS BUILT DARK. `ont_property_policies` has existed since 0154 with FORCE
-- RLS and append-only triggers; `ont_property_defs.in_property_policy` (0152:59)
-- has been carried faithfully through every key revision (0165:521-632) and
-- served over HTTP; and `PgCedarPolicyStore::authorize_property_field` has
-- computed a field decision and stamped it into the append-only Integrity feed.
-- Nothing acted on any of it. There was NO HTTP path that writes
-- `ont_property_policies` at all, and every principal who could read an instance
-- read every field of it. A decision logged as if enforced is worse than an
-- unused table.
--
-- TWO THINGS THIS MIGRATION DOES, and they belong in one file because the second
-- is only safe once the first exists.
--
-- 1. `activity`. SAP's authorization field is the "Smallest unit of an
--    authorization object … either data such as a key field of a database table
--    OR ACTIVITIES SUCH AS READING OR CHANGING"
--    (help.sap.com/doc/abapdocu_751_index_htm/7.51/en-US/abenauthorization_field_glosry.htm,
--    fetched). Without the second half a field policy is a read mask that every
--    write path walks straight through. The two values are NOT a new vocabulary:
--    they are the Cedar action names the authoring schema already declares
--    (`authoring.rs` `AUTHORING_ACTIONS`), `read_field` and `edit`, so there is
--    no translation layer between the attachment and the policy that decides it.
--    `UNIQUE (org_id, property_def_id)` becomes
--    `UNIQUE (org_id, property_def_id, activity)`: 0154's "at most one property
--    policy per property" is preserved, once per activity.
--
--    Done NOW rather than later because it is a unique-constraint change on an
--    append-only table from which UPDATE and DELETE are revoked: after rows
--    exist there is no in-place way to split them.
--
-- 2. `REVOKE INSERT ON ont_property_policies FROM console_rt`. **0154:106 granted
--    it and nothing ever took it back.** 0205:187 performed exactly this revoke
--    for `ont_object_policies` and skipped the property twin. Today that
--    self-grant only skews a what-if answer nothing reads; the moment the read
--    path starts REMOVING fields on a property decision it becomes a
--    self-authorization primitive — the runtime role could bind any existing
--    enforced catalog policy to any property with one bare statement. It has to
--    close in the same migration that creates the enforcement, not after it.
--
-- THE ONTOLOGY -> POLICY JOIN, ENFORCED IN SQL FOR THE FIRST TIME.
-- `enforce_ont_property_policy_declared` requires the target `ont_property_defs`
-- row to be same-org AND to carry `in_property_policy = true`. Until now that
-- column was a label with no consequence anywhere in the system; from here it is
-- the tenant's declaration of which fields are policy-bearing, and a policy
-- cannot be attached to a field that was never declared one. Modelled on 0170's
-- `enforce_ont_object_policy_effect_matches_catalog`, and — like 0205 §2 — it
-- pins `search_path = pg_catalog` and schema-qualifies its own reads, because it
-- fires from inside a definer that runs under that pinned path and an
-- unqualified `public` read there raises 42P01 and fails every attach.
--
-- WHAT IS NOT HERE, deliberately. There is no `effect` column on
-- `ont_property_policies` (0154 did not give it one), so there is no
-- attachment-vs-catalog effect comparison to enforce in a trigger. The
-- equivalent guarantee is made where it can be made completely: the row-writer
-- below compares `p_normalized_row->>'effect'` to the catalog effect it is about
-- to write, and the read path re-derives every policy from `normalized_row` and
-- refuses any row whose blocks disagree with its catalog effect.
--
-- SHAPE. §4/§5 are 0205 and 0206 line for line, one table over: an owner-only
-- row-writer that holds the whole envelope, and an audited entrypoint in front
-- of it that `console_ontology_cmd` may execute and cannot bypass. The audit
-- INSERT is LAST for 0206's reason — the catalog INSERT inside the row-writer is
-- the statement the RLS org floor stops on a cross-org call, and that refusal is
-- the only proof the floor still applies inside the definer.
--
-- No `CREATE ROLE` anywhere: cluster-global roles are infrastructure-owned and
-- this migration fails closed on any drift.
--
-- No routine is added to the `ontology_api` schema: its routine count and
-- namespace ACL are pinned by
-- ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs.

-- ---------------------------------------------------------------------------
-- 1. Preconditions. 0206 §1 re-run, verbatim in substance: the same four roles,
--    held to the same bar. A BYPASSRLS or superuser writer/command role would
--    carry the org floor away and every functional test here would still pass.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_migrator OID := pg_catalog.to_regrole('console_app');
    v_runtime OID := pg_catalog.to_regrole('console_rt');
    v_writer OID := pg_catalog.to_regrole('console_ontology_writer');
    v_command OID := pg_catalog.to_regrole('console_ontology_cmd');
    v_applier_is_superuser BOOLEAN;
BEGIN
    IF v_migrator IS NULL OR v_runtime IS NULL OR v_writer IS NULL OR v_command IS NULL THEN
        RAISE EXCEPTION 'property-policy writer precondition failed: roles are not preprovisioned';
    END IF;
    SELECT rolsuper INTO v_applier_is_superuser
      FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER;
    IF NOT v_applier_is_superuser
       AND (CURRENT_USER <> 'console_app' OR SESSION_USER <> 'console_app') THEN
        RAISE EXCEPTION 'property-policy writer precondition failed: console_app must apply directly';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_writer
          AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit
               OR rolcreatedb OR rolcreaterole OR rolreplication)
    ) THEN
        RAISE EXCEPTION 'property-policy writer precondition failed: console_ontology_writer is unsafe';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_runtime
          AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit
               OR rolcreatedb OR rolcreaterole OR rolreplication)
    ) THEN
        RAISE EXCEPTION 'property-policy writer precondition failed: console_rt is unsafe';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_command
          AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit
               OR rolcreatedb OR rolcreaterole OR rolreplication)
    ) THEN
        RAISE EXCEPTION 'property-policy writer precondition failed: console_ontology_cmd is unsafe';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. `activity`, and the unique key it splits.
--
--    DEFAULT 'read_field' rather than NULL-then-backfill: the column is NOT NULL
--    and 0154 revoked UPDATE from every role, so a nullable column could never
--    be filled in afterwards by anything short of another migration. Existing
--    rows were authored under the read-only reading of this table, which is what
--    the default records.
-- ---------------------------------------------------------------------------
ALTER TABLE ont_property_policies
    ADD COLUMN activity TEXT NOT NULL DEFAULT 'read_field'
    CHECK (activity IN ('read_field', 'edit'));

COMMENT ON COLUMN ont_property_policies.activity IS
    'pd:none — closed authorization activity vocabulary; contains no natural-person fact';

-- The 0154 constraint is dropped by its generated name, then the drop is
-- VERIFIED rather than assumed: a renamed constraint would leave the old
-- one-row-per-property rule in force, the `edit` attach would fail with a
-- duplicate-key error the first time a property carried both activities, and
-- nothing in this file would have said so.
ALTER TABLE ont_property_policies
    DROP CONSTRAINT IF EXISTS ont_property_policies_org_id_property_def_id_key;

DO $$
DECLARE
    v_stale TEXT;
BEGIN
    SELECT string_agg(c.conname, ', ')
      INTO v_stale
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.ont_property_policies'::regclass
       AND c.contype = 'u'
       AND (
           -- `attname` is `name`, not `text`, and `name[] = text[]` has no
           -- operator: the cast is what makes this comparison exist at all.
           SELECT array_agg(a.attname::text ORDER BY a.attname)
             FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       ) = ARRAY['org_id', 'property_def_id'];
    IF v_stale IS NOT NULL THEN
        RAISE EXCEPTION
            'property-policy activity split failed: the per-property unique key survived as %',
            v_stale;
    END IF;
END
$$;

ALTER TABLE ont_property_policies
    ADD CONSTRAINT ont_property_policies_org_prop_activity_key
    UNIQUE (org_id, property_def_id, activity);

-- ---------------------------------------------------------------------------
-- 3. The self-authorization primitive 0205 closed for object policies and left
--    open here. SELECT is untouched: the read path joins this table on every
--    policy-filtered read.
-- ---------------------------------------------------------------------------
REVOKE INSERT ON ont_property_policies FROM console_rt;

-- ---------------------------------------------------------------------------
-- 4. The ontology -> policy join. `in_property_policy` means something from here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION enforce_ont_property_policy_declared()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
    v_declared BOOLEAN;
BEGIN
    -- Same-org by construction: `ont_property_defs` is FORCE-RLS org-scoped
    -- (0152), and the NEW.org_id predicate makes the intent explicit rather than
    -- leaning on the armed GUC alone.
    SELECT in_property_policy INTO v_declared
      FROM public.ont_property_defs
     WHERE id = NEW.property_def_id AND org_id = NEW.org_id;

    IF v_declared IS NULL THEN
        RAISE EXCEPTION 'property policy attachment requires a same-org property definition';
    END IF;
    IF NOT v_declared THEN
        RAISE EXCEPTION
            'property policy attachment refused: property % is not declared in_property_policy',
            NEW.property_def_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.cedar_policy_catalog_entries
         WHERE id = NEW.cedar_policy_id AND org_id = NEW.org_id
    ) THEN
        RAISE EXCEPTION 'property policy attachment requires a same-org catalog entry';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ont_property_policies_declared
BEFORE INSERT ON ont_property_policies
FOR EACH ROW EXECUTE FUNCTION enforce_ont_property_policy_declared();

-- ---------------------------------------------------------------------------
-- 5. Grants the definer needs. The writer gets no UPDATE and no DELETE anywhere:
--    both tables are append-only by construction (0154:90-99).
--    `cedar_policy_catalog_entries` and `ont_object_types` were already granted
--    by 0205 §3; only the two property tables are new.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON public.ont_property_policies TO console_ontology_writer;
-- §6 resolves the property's key and its owning object type's `stable_key` to
-- derive the catalog stable_key and to check `normalized_row.resource_type`.
-- Read-only, and FORCE RLS keeps it inside the armed org.
GRANT SELECT ON public.ont_property_defs TO console_ontology_writer;

-- ---------------------------------------------------------------------------
-- 6. The row-writer. 0205 §4 one table over, including its four deletions:
--    `stable_key`, `title`, `natural_language_rule` and the bundle digest are
--    DERIVED here, never accepted, so a hand-crafted call cannot forge a value it
--    cannot supply. `generated_policy_text` is not accepted either and NULL is
--    stored — rendering Cedar in SQL would be a second copy of
--    `generate_cedar_text_with` living in a migration, and the read path
--    re-derives everything from `normalized_row` and never reads the text.
--
--    The org floor is deliberately NOT re-implemented (no
--    `p_org_id = current_setting('app.current_org')`, no `org_id` filter on the
--    lookups): either one pre-empts RLS on the only path that reaches the floor
--    and makes the cross-org refusal unprovable. RLS already scopes the lookups.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ont_policy_api.attach_property_policy_rows(
    p_org_id UUID,
    p_created_by UUID,
    p_property_def_id UUID,
    p_activity TEXT,
    p_effect TEXT,
    p_normalized_row JSONB,
    p_schema_version TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
    v_policy_id UUID;
    v_property_key TEXT;
    v_type_key TEXT;
    v_declared BOOLEAN;
BEGIN
    -- The attached property, resolved under the caller's org floor. There is no
    -- FK on ont_property_policies.property_def_id (0154:47), so an unresolvable
    -- or foreign id would otherwise attach an enforced policy to nothing.
    SELECT p.key, p.in_property_policy, t.stable_key
      INTO v_property_key, v_declared, v_type_key
      FROM public.ont_property_defs p
      JOIN public.ont_object_types t ON t.id = p.object_type_id
     WHERE p.id = p_property_def_id;
    IF v_property_key IS NULL THEN
        RAISE EXCEPTION 'attach refused: unknown property definition %', p_property_def_id;
    END IF;
    -- Also enforced by the trigger below the INSERT. Checked here too so the
    -- refusal names the property rather than surfacing as a trigger error from
    -- inside a statement the caller cannot see.
    IF NOT v_declared THEN
        RAISE EXCEPTION 'attach refused: property % is not declared in_property_policy', v_property_key;
    END IF;

    -- A row whose resource_type disagrees with the object type that OWNS the
    -- property never matches on the read path, so it would deny forever at
    -- HTTP 200 -- a silent failure no post-hoc test can see.
    IF p_normalized_row ->> 'resource_type' IS DISTINCT FROM v_type_key THEN
        RAISE EXCEPTION 'attach refused: normalized_row resource_type % is not the property''s object type %',
            p_normalized_row ->> 'resource_type', v_type_key;
    END IF;

    -- The activity IS the Cedar action. The read path filters attachments by
    -- activity and evaluates the policy under that action, so a disagreement
    -- here is an attachment that can never decide anything.
    IF p_activity NOT IN ('read_field', 'edit') THEN
        RAISE EXCEPTION 'attach refused: unknown activity %', p_activity;
    END IF;
    IF p_normalized_row ->> 'action' IS DISTINCT FROM p_activity THEN
        RAISE EXCEPTION 'attach refused: normalized_row action % is not the attachment activity %',
            p_normalized_row ->> 'action', p_activity;
    END IF;

    -- `ont_property_policies` has no `effect` column, so no trigger can compare
    -- the attachment to the catalog. This is the ONLY place blocks and catalog
    -- are compared at write time.
    IF p_normalized_row ->> 'effect' IS DISTINCT FROM p_effect THEN
        RAISE EXCEPTION 'attach refused: normalized_row effect % disagrees with the attachment effect %',
            p_normalized_row ->> 'effect', p_effect;
    END IF;

    -- Mirrors MAX_ATTACHED_CONDITIONS (`ontology/rest/src/lib.rs`). Both tables
    -- are append-only, so an oversized list is permanent work charged to every
    -- later read of the type.
    IF jsonb_typeof(p_normalized_row -> 'conditions') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_normalized_row -> 'conditions') > 32 THEN
        RAISE EXCEPTION 'attach refused: conditions must be an array of at most 32 entries';
    END IF;

    INSERT INTO public.cedar_policy_catalog_entries
        (org_id, stable_key, title, natural_language_rule, effect, status, source,
         principal, action, resource, conditions,
         policy_version, schema_version, bundle_digest,
         validation_status, normalized_row, generated_policy_text,
         created_by, updated_by)
    VALUES
        (p_org_id,
         -- Dotted with >= 2 segments (0150:11) and UNIQUE per (org, key, status),
         -- so it carries the field it policies plus a fresh discriminator.
         'property_policy.' || v_type_key || '.' || v_property_key || '.'
             || replace(gen_random_uuid()::text, '-', ''),
         -- title is bounded to 120 chars and the rule to 1000 (0150:12-13) while
         -- neither an object-type key nor a property key has a length CHECK.
         -- Bound the human-readable label; never the matching key.
         'Field policy: ' || left(v_type_key, 40) || '.' || left(v_property_key, 40),
         CASE p_effect WHEN 'permit' THEN 'Permit' ELSE 'Forbid' END
             || CASE p_activity WHEN 'edit' THEN ' changing ' ELSE ' reading ' END
             || left(v_property_key, 40) || ' on ' || left(v_type_key, 40)
             || ' when every authored condition holds.',
         p_effect,
         'enforced', 'no_code_draft',
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
         1, p_schema_version,
         -- Derived from the row actually stored beside it. A supplied digest is a
         -- stored false attestation nothing ever re-checks. `jsonb::text` is
         -- canonical (keys sorted, whitespace fixed), so this is stable.
         'sha256:' || encode(sha256(convert_to(p_normalized_row::text, 'UTF8')), 'hex'),
         'valid', p_normalized_row, NULL,
         p_created_by, p_created_by)
    RETURNING id INTO v_policy_id;

    INSERT INTO public.ont_property_policies
        (org_id, property_def_id, cedar_policy_id, activity, created_by)
    VALUES
        (p_org_id, p_property_def_id, v_policy_id, p_activity, p_created_by);

    RETURN v_policy_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. The audited entrypoint. It performs NO envelope checks of its own: every
--    one of them lives in the row-writer, which is the single source. A copy
--    here is how the two diverge.
--
--    The audit INSERT is LAST. See 0206 §4: the catalog INSERT inside the
--    row-writer is what the org floor refuses on a cross-org call, and
--    audit-first moves that proof onto `audit_events`.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ont_policy_api.attach_property_policy(
    p_org_id UUID,
    p_created_by UUID,
    p_property_def_id UUID,
    p_activity TEXT,
    p_effect TEXT,
    p_normalized_row JSONB,
    p_schema_version TEXT,
    p_trace_id TEXT,
    p_span_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
    v_policy_id UUID;
    v_occurred_at TIMESTAMPTZ := pg_catalog.statement_timestamp();
BEGIN
    v_policy_id := ont_policy_api.attach_property_policy_rows(
        p_org_id, p_created_by, p_property_def_id, p_activity, p_effect,
        p_normalized_row, p_schema_version);

    -- `id` is omitted so the 0003:11 `DEFAULT gen_random_uuid()` supplies it:
    -- column defaults carry resolved function OIDs and are unaffected by this
    -- routine's pinned `search_path`.
    INSERT INTO public.audit_events
        (actor, action, target_type, target_id, branch_id,
         before_snap, after_snap, trace_id, span_id, occurred_at, org_id)
    VALUES
        (p_created_by, 'ontology.property_policy.attach',
         'ont_property_policies', p_property_def_id::TEXT, NULL,
         NULL, p_normalized_row, p_trace_id, p_span_id, v_occurred_at, p_org_id);

    RETURN v_policy_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Owner and ACL. 0206 §5's shape: ALTER OWNER first (revoking from PUBLIC is
--    what materializes a NULL `proacl`, and the materialized default names the
--    CURRENT owner as grantee and grantor), then ONE blanket REVOKE over the
--    schema, then the single EXECUTE grant per audited entrypoint.
--
--    The blanket REVOKE also strips 0206's grant on `attach_object_policy`, so
--    it is re-granted below. Both entrypoints are listed in one place, which is
--    the property 0206 introduced the blanket form to get.
-- ---------------------------------------------------------------------------
ALTER FUNCTION ont_policy_api.attach_property_policy_rows(
    UUID, UUID, UUID, TEXT, TEXT, JSONB, TEXT
) OWNER TO console_ontology_writer;
ALTER FUNCTION ont_policy_api.attach_property_policy(
    UUID, UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) OWNER TO console_ontology_writer;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ont_policy_api
    FROM PUBLIC, console_rt, console_ontology_cmd;

GRANT EXECUTE ON FUNCTION ont_policy_api.attach_object_policy(
    UUID, UUID, UUID, TEXT, JSONB, TEXT, TEXT, TEXT
) TO console_ontology_cmd;
GRANT EXECUTE ON FUNCTION ont_policy_api.attach_property_policy(
    UUID, UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) TO console_ontology_cmd;

-- ---------------------------------------------------------------------------
-- 9. Owner pin over EVERY routine in the schema — there are four now. A dropped
--    ALTER FUNCTION … OWNER TO leaves the applier as owner (console_app in
--    production, the bootstrap superuser under sqlx::test — both BYPASSRLS): the
--    org floor would be gone and every functional test would still pass. Fail
--    the migration instead.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname || ' owned by ' || r.rolname, ', ' ORDER BY p.proname)
      INTO v_bad
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'ont_policy_api'
       AND (r.rolname <> 'console_ontology_writer' OR r.rolsuper OR r.rolbypassrls);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'property-policy definer ownership is unsafe: %', v_bad;
    END IF;
END
$$;
