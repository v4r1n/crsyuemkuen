BEGIN;
CREATE TABLE crs.notification_preferences (
 user_id text NOT NULL REFERENCES crs.users(id),
 event text NOT NULL CHECK(event IN ('BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN','ADMIN_BORROW_REQUEST','ADMIN_REQUEST_RETURN')),
 in_app boolean NOT NULL DEFAULT true,
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,event)
);
ALTER TABLE crs.notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crs.notification_preferences FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON crs.notification_preferences FROM anon,authenticated;
 END IF;
END $$;
COMMIT;
