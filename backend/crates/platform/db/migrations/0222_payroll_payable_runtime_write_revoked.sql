-- REG-P4: make `payroll_line_calculations` append-only in the database, not in
-- review.
--
-- Migration 0186 declares these rows "append-only ... only the `payable` flip
-- is a legal update", and `payable` gates nothing the runtime role may set.
-- Neither property was enforced: `console_rt` -- the role the application
-- actually runs as -- held table-wide INSERT and UPDATE. Verified against a
-- PostgreSQL 18.4 replica of the CI topology, as `console_rt`:
-- `UPDATE payroll_line_calculations SET payable = TRUE` succeeded.
--
-- NO UPDATE IS GRANTED BACK. An earlier revision of this migration re-granted
-- UPDATE on every non-`payable` column to avoid disturbing the writer. That was
-- wrong: nothing in the tree updates this table -- the only writer
-- (payroll/adapter-postgres lifecycle.rs) is a plain INSERT with an explicit
-- column list, and there is no `ON CONFLICT DO UPDATE` anywhere against it. So
-- re-granting UPDATE preserved a privilege no caller uses, and left
-- `gross_won`, `deductions`, `net_won` and `tax_table_version` rewritable after
-- calculation and review by any tenant-scoped session. Those columns are read
-- straight into payslip issuance. Append-only is the declared contract; this
-- grants what the contract allows and nothing more.
--
-- WHY A TABLE-LEVEL REVOKE AND A COLUMN-LEVEL RE-GRANT:
-- a column-level REVOKE cannot subtract from a table-level grant. Running
-- `REVOKE INSERT (payable), UPDATE (payable) ... FROM console_rt` against the
-- table-wide grant is a silent no-op -- measured, not assumed: `UPDATE ... SET
-- payable = TRUE` still succeeded afterwards. The privilege has to be removed
-- at table scope and re-granted per column.
--
-- `console_app` (the migration owner) deliberately keeps its privileges. The
-- release path `payable` exists for is a later, separately reviewed decision;
-- this removes the ambient ability, it does not decide who may eventually
-- grant it.
DO $$
DECLARE
    v_insert_columns TEXT;
BEGIN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_insert_columns
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payroll_line_calculations'
       AND column_name <> 'payable';

    IF v_insert_columns IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '42P01',
            MESSAGE = 'payroll_payable.table_absent_or_columnless';
    END IF;

    EXECUTE 'REVOKE INSERT, UPDATE ON public.payroll_line_calculations FROM console_rt';
    EXECUTE format(
        'GRANT INSERT (%s) ON public.payroll_line_calculations TO console_rt', v_insert_columns);
END $$;

-- The migration proves its own effect rather than asserting it. All three
-- clauses matter: dropping too much would break the calculation writer, which
-- inserts an explicit column list excluding `payable`. A migration that fails
-- closed on payroll writes is not a fix.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.column_privileges
         WHERE table_name = 'payroll_line_calculations'
           AND grantee = 'console_rt'
           AND privilege_type = 'UPDATE'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'payroll_payable.runtime_update_not_revoked';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.column_privileges
         WHERE table_name = 'payroll_line_calculations'
           AND column_name = 'payable'
           AND grantee = 'console_rt'
           AND privilege_type = 'INSERT'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'payroll_payable.runtime_insert_not_revoked';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.column_privileges
         WHERE table_name = 'payroll_line_calculations'
           AND column_name = 'net_won'
           AND grantee = 'console_rt'
           AND privilege_type = 'INSERT'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'payroll_payable.runtime_lost_legitimate_insert';
    END IF;
END $$;
