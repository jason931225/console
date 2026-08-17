-- REG-P4: make `payable` fail closed in the database, not in review.
--
-- `payroll_line_calculations.payable` (migration 0186) was declared
-- `BOOLEAN NOT NULL DEFAULT FALSE` with the comment "true only after
-- release-gate pass", and no writer sets it. That is a code-review claim, not
-- an enforced constraint: `console_rt` — the role the application actually runs
-- as — held table-wide INSERT and UPDATE, so it could set `payable = TRUE` at
-- any time. Verified against a PostgreSQL 18.4 replica of the CI topology:
-- `UPDATE payroll_line_calculations SET payable = TRUE` succeeded as
-- `console_rt` before this migration.
--
-- WHY A TABLE-LEVEL REVOKE AND RE-GRANT, NOT `REVOKE UPDATE (payable)`:
-- a column-level REVOKE cannot subtract from a table-level grant. Running
-- `REVOKE INSERT (payable), UPDATE (payable) ... FROM console_rt` against the
-- table-wide grant is a silent no-op — measured, not assumed: `UPDATE ... SET
-- payable = TRUE` still succeeded afterwards. The privilege must be removed at
-- table scope and re-granted per column, omitting `payable`.
--
-- `console_app` (the migration owner) deliberately keeps the privilege. The
-- release path this column exists for is a later, separately reviewed decision;
-- this migration removes the ambient ability, it does not decide who may
-- eventually grant it.
DO $$
DECLARE
    v_columns TEXT;
BEGIN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_columns
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payroll_line_calculations'
       AND column_name <> 'payable';

    IF v_columns IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '42P01',
            MESSAGE = 'payroll_payable.table_absent_or_columnless';
    END IF;

    EXECUTE 'REVOKE INSERT, UPDATE ON public.payroll_line_calculations FROM console_rt';
    EXECUTE format(
        'GRANT INSERT (%s) ON public.payroll_line_calculations TO console_rt', v_columns);
    EXECUTE format(
        'GRANT UPDATE (%s) ON public.payroll_line_calculations TO console_rt', v_columns);
END $$;

-- The migration proves its own effect rather than asserting it. Both halves
-- matter: revoking too much would break the calculation writer, which inserts
-- an explicit column list excluding `payable` (payroll/adapter-postgres
-- lifecycle.rs). A migration that fails closed on payroll writes is not a fix.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.column_privileges
         WHERE table_name = 'payroll_line_calculations'
           AND column_name = 'payable'
           AND grantee = 'console_rt'
           AND privilege_type IN ('INSERT', 'UPDATE')
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'payroll_payable.runtime_write_not_revoked';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.column_privileges
         WHERE table_name = 'payroll_line_calculations'
           AND column_name = 'net_won'
           AND grantee = 'console_rt'
           AND privilege_type = 'UPDATE'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'payroll_payable.runtime_lost_legitimate_write';
    END IF;
END $$;
