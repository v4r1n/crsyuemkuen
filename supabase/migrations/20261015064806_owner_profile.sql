BEGIN;
CREATE TABLE crs.profile_resources (
 id uuid PRIMARY KEY,
 -- Like image_resources, reservations precede canonical records on restore.
 -- Runtime owner/operation authorization is enforced before reservation.
 owner_user_id text NOT NULL CHECK(owner_user_id ~ '^USR-[0-9]{6}$'),
 operation_id text NOT NULL UNIQUE,
 object_key text NOT NULL UNIQUE,
 mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 1048576),
 digest text NOT NULL CHECK(digest ~ '^[A-Za-z0-9_-]{43}$'),
 previous_id uuid REFERENCES crs.profile_resources(id) DEFERRABLE INITIALLY DEFERRED,
 state text NOT NULL CHECK(state IN ('STAGED','READY','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz
);
CREATE UNIQUE INDEX profile_resources_current_owner ON crs.profile_resources(owner_user_id) WHERE state='READY';
CREATE INDEX profile_resources_owner ON crs.profile_resources(owner_user_id,created_at);
ALTER TABLE crs.profile_resources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crs.profile_resources FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON crs.profile_resources FROM anon,authenticated;
 END IF;
END $$;
COMMIT;
