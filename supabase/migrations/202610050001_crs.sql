BEGIN;
CREATE SCHEMA IF NOT EXISTS crs;
REVOKE ALL ON SCHEMA crs FROM PUBLIC;
-- Dedicated server database credentials only. crs is not a Data API schema.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA crs FROM anon, authenticated';
  END IF;
END $$;

CREATE TABLE crs.users (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'user_id') STORED PRIMARY KEY CHECK(id ~ '^USR-[0-9]{6}$'),
 email text GENERATED ALWAYS AS (lower(btrim(data->>'email'))) STORED NOT NULL UNIQUE,
 role text GENERATED ALWAYS AS (data->>'role') STORED NOT NULL CHECK(role IN ('USER','ADMIN')),
 status text GENERATED ALWAYS AS (data->>'status') STORED NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')),
 CHECK(email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 CHECK((data->>'row_version')::bigint >= 1)
);
CREATE TABLE crs.categories (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'category_id') STORED PRIMARY KEY CHECK(id ~ '^CAT-[0-9]{3}$'),
 name text GENERATED ALWAYS AS (lower(btrim(data->>'category_name'))) STORED NOT NULL UNIQUE,
 status text GENERATED ALWAYS AS (data->>'status') STORED NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')),
 CHECK((data->>'row_version')::bigint >= 1)
);
CREATE TABLE crs.equipment (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'asset_id') STORED PRIMARY KEY CHECK(id ~ '^AST-[0-9]{6}$'),
 category_id text GENERATED ALWAYS AS (data->>'category_id') STORED NOT NULL REFERENCES crs.categories(id) DEFERRABLE INITIALLY DEFERRED,
 serial text GENERATED ALWAYS AS (nullif(lower(regexp_replace(btrim(data->>'serial_number'), '\s+', ' ', 'g')),'')) STORED UNIQUE,
 status text GENERATED ALWAYS AS (data->>'status') STORED NOT NULL CHECK(status IN ('AVAILABLE','PENDING','RESERVED','BORROWED','RETURNING','MAINTENANCE','DAMAGED','LOST','RETIRED','DELETED')),
 CHECK((data->>'quantity')::integer = 1), CHECK((data->>'row_version')::bigint >= 1)
);
CREATE TABLE crs.borrow (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'borrow_id') STORED PRIMARY KEY CHECK(id ~ '^BR-[0-9]{6}$'),
 asset_id text GENERATED ALWAYS AS (data->>'asset_id') STORED NOT NULL REFERENCES crs.equipment(id) DEFERRABLE INITIALLY DEFERRED,
 user_id text GENERATED ALWAYS AS (data->>'user_id') STORED NOT NULL REFERENCES crs.users(id) DEFERRABLE INITIALLY DEFERRED,
 status text GENERATED ALWAYS AS (data->>'status') STORED NOT NULL CHECK(status IN ('PENDING_APPROVAL','APPROVED','REJECTED','CHECKED_OUT','RETURN_REQUESTED','RETURNED','CANCELLED')),
 CHECK((data->>'row_version')::bigint >= 1),
 CHECK((data->>'due_date')::date >= (data->>'borrow_date')::date)
);
CREATE UNIQUE INDEX one_active_borrow_per_asset ON crs.borrow(asset_id)
 WHERE status IN ('PENDING_APPROVAL','APPROVED','CHECKED_OUT','RETURN_REQUESTED');
CREATE TABLE crs.included_items (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'item_id') STORED PRIMARY KEY CHECK(id ~ '^ITM-[0-9]{6}$'),
 asset_id text GENERATED ALWAYS AS (data->>'asset_id') STORED NOT NULL REFERENCES crs.equipment(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((data->>'quantity')::integer >= 1),
 CHECK(data->>'status' IN ('ACTIVE','INACTIVE'))
);
CREATE TABLE crs.borrow_items (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'borrow_item_id') STORED PRIMARY KEY CHECK(id ~ '^BIT-[0-9]{6}$'),
 borrow_id text GENERATED ALWAYS AS (data->>'borrow_id') STORED NOT NULL REFERENCES crs.borrow(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((data->>'expected_quantity')::integer >= 1)
);
-- History can reference absent historical entities. Preserve that evidence exactly;
-- imposing live FKs here would discard valid legacy delete/borrow history.
CREATE TABLE crs.history (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'log_id') STORED PRIMARY KEY CHECK(id ~ '^LOG-[0-9]{6}$'),
 operation_id text GENERATED ALWAYS AS (nullif(data->>'operation_id','')) STORED UNIQUE
);
CREATE TABLE crs.operations (
 data jsonb NOT NULL,
 id text GENERATED ALWAYS AS (data->>'operation_id') STORED PRIMARY KEY,
 status text GENERATED ALWAYS AS (data->>'status') STORED NOT NULL CHECK(status IN ('STARTED','COMPLETED','ABORTED')),
 CHECK(id ~ '^[A-Za-z0-9_-]{8,100}$')
);
CREATE TABLE crs.settings (data jsonb NOT NULL, id text GENERATED ALWAYS AS (data->>'setting_key') STORED PRIMARY KEY);
CREATE TABLE crs.sequences (
 data jsonb NOT NULL, id text GENERATED ALWAYS AS (data->>'sequence_name') STORED PRIMARY KEY,
 CHECK((data->>'next_value')::bigint >= 1)
);
CREATE TABLE crs.schema_migrations (data jsonb NOT NULL, id text GENERATED ALWAYS AS (data->>'migration_id') STORED PRIMARY KEY);
CREATE TABLE crs.migration_runs (
 source_hash text PRIMARY KEY, manifest jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crs.archive (
 id text PRIMARY KEY, source_hash text NOT NULL, sheet text NOT NULL, row_number integer NOT NULL,
 reason text NOT NULL, raw jsonb NOT NULL
);
CREATE TABLE crs.auth_flows (
 id text PRIMARY KEY, state_hash text NOT NULL UNIQUE, poll_hash text NOT NULL, session_hash text NOT NULL UNIQUE,
 status text NOT NULL, data jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE crs.sessions (
 id text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE crs.proofs (id text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE crs.rate_limits (id text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE crs.image_resources (
 id text PRIMARY KEY, object_key text NOT NULL UNIQUE, operation_id text NOT NULL UNIQUE,
 asset_id text NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
 byte_length integer NOT NULL CHECK(byte_length > 0 AND byte_length <= 10485760),
 digest text NOT NULL CHECK(digest ~ '^[A-Za-z0-9_-]{43}$'), name text NOT NULL,
 folder_id text NOT NULL, owner_user_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('STAGED','READY','TRASHED')),
 created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
 cleanup_after timestamptz, original jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE crs.cleanup_jobs (id text PRIMARY KEY REFERENCES crs.image_resources(id), not_before timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION crs.protect_records() RETURNS trigger LANGUAGE plpgsql SET search_path=crs,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Hard delete forbidden: %', TG_TABLE_NAME; END IF;
 IF TG_TABLE_NAME IN ('history','archive','migration_runs') THEN RAISE EXCEPTION 'Append-only: %', TG_TABLE_NAME; END IF;
 -- Stored generated columns are computed AFTER BEFORE triggers; NEW.id is
 -- not yet available here. Compare the authoritative JSON primary key.
 IF (OLD.data->>TG_ARGV[0]) IS DISTINCT FROM (NEW.data->>TG_ARGV[0]) THEN RAISE EXCEPTION 'Immutable ID'; END IF;
 IF TG_TABLE_NAME='equipment' AND OLD.data->>'status'='DELETED' AND NEW.data->>'status'<>'DELETED' THEN
   RAISE EXCEPTION 'DELETED is terminal';
 END IF;
 IF TG_TABLE_NAME='borrow_items' AND
   (OLD.data - ARRAY['returned_quantity','is_complete','condition','note','checked_by','checked_at']) IS DISTINCT FROM
   (NEW.data - ARRAY['returned_quantity','is_complete','condition','note','checked_by','checked_at']) THEN
   RAISE EXCEPTION 'Borrow checklist snapshot is immutable';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE table_name text; primary_key text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['users','categories','equipment','borrow','included_items','borrow_items','history','operations','settings','sequences','schema_migrations','archive','migration_runs'] LOOP
   primary_key := CASE table_name
     WHEN 'users' THEN 'user_id' WHEN 'categories' THEN 'category_id' WHEN 'equipment' THEN 'asset_id'
     WHEN 'borrow' THEN 'borrow_id' WHEN 'included_items' THEN 'item_id' WHEN 'borrow_items' THEN 'borrow_item_id'
     WHEN 'history' THEN 'log_id' WHEN 'operations' THEN 'operation_id' WHEN 'settings' THEN 'setting_key'
     WHEN 'sequences' THEN 'sequence_name' WHEN 'schema_migrations' THEN 'migration_id' ELSE 'id' END;
   EXECUTE format('CREATE TRIGGER protect_records BEFORE UPDATE OR DELETE ON crs.%I FOR EACH ROW EXECUTE FUNCTION crs.protect_records(%L)', table_name,primary_key);
 END LOOP;
 FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='crs' LOOP
   EXECUTE format('ALTER TABLE crs.%I ENABLE ROW LEVEL SECURITY', table_name);
   EXECUTE format('REVOKE ALL ON crs.%I FROM PUBLIC', table_name);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crs FROM PUBLIC;
COMMIT;
