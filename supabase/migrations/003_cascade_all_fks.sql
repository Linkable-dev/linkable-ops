-- One-time migration: rewrite ALL foreign key constraints to ON DELETE CASCADE.
-- This ensures deleting a parent row automatically cleans up child rows
-- across every table, without application-level cascade logic.

DO $$
DECLARE
  r RECORD;
  col_names TEXT;
  ref_col_names TEXT;
BEGIN
  FOR r IN
    SELECT
      con.conname                           AS constraint_name,
      cl.relname                            AS child_table,
      ref.relname                           AS parent_table,
      con.conrelid,
      con.confrelid,
      con.conkey,
      con.confkey
    FROM pg_constraint con
    JOIN pg_class cl     ON cl.oid  = con.conrelid
    JOIN pg_class ref    ON ref.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid  = cl.relnamespace
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
      AND con.confdeltype <> 'c'  -- skip if already CASCADE ('c')
  LOOP
    -- Build column name lists for multi-column FKs
    SELECT string_agg(quote_ident(att.attname), ', ' ORDER BY ord.n)
      INTO col_names
      FROM unnest(r.conkey) WITH ORDINALITY AS ord(col, n)
      JOIN pg_attribute att ON att.attrelid = r.conrelid AND att.attnum = ord.col;

    SELECT string_agg(quote_ident(att.attname), ', ' ORDER BY ord.n)
      INTO ref_col_names
      FROM unnest(r.confkey) WITH ORDINALITY AS ord(col, n)
      JOIN pg_attribute att ON att.attrelid = r.confrelid AND att.attnum = ord.col;

    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT %I',
      r.child_table, r.constraint_name
    );

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I(%s) ON DELETE CASCADE',
      r.child_table, r.constraint_name, col_names, r.parent_table, ref_col_names
    );

    RAISE NOTICE 'Rewired % on % -> % to CASCADE', r.constraint_name, r.child_table, r.parent_table;
  END LOOP;
END $$;
