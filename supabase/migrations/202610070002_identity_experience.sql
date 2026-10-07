BEGIN;
-- Additive private records. No legacy business row, role or workflow is changed.
CREATE TABLE crs.password_credentials (
 user_id text PRIMARY KEY REFERENCES crs.users(id),
 email text NOT NULL,
 password_hash text NOT NULL CHECK(password_hash LIKE 'scrypt$%'),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0),
 must_change boolean NOT NULL DEFAULT false,
 temporary_expires_at timestamptz,
 failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
 locked_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crs.password_challenges (
 id text PRIMARY KEY,
 user_id text REFERENCES crs.users(id), email text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('CHANGE','RESET')),
 session_hash text,
 credential_generation bigint NOT NULL,
 otp_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 status text NOT NULL CHECK(status IN ('SENDING','READY','VERIFIED','CONSUMED','DENIED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 verified_until timestamptz
);
CREATE INDEX password_challenge_subject ON crs.password_challenges(email,created_at);
-- Contains no OTP, password or SMTP payload. Only bounded non-secret events.
CREATE TABLE crs.security_mail (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES crs.users(id),
 email text NOT NULL, kind text NOT NULL CHECK(kind IN ('PASSWORD_CHANGED','TEMPORARY_PASSWORD')),
 status text NOT NULL CHECK(status IN ('PENDING','SENDING','SENT','UNCERTAIN','DENIED')),
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE TABLE crs.equipment_visibility (
 asset_id text PRIMARY KEY REFERENCES crs.equipment(id),
 is_public boolean NOT NULL DEFAULT false,
 updated_by text NOT NULL REFERENCES crs.users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE crs.notifications (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES crs.users(id),
 history_id text NOT NULL REFERENCES crs.history(id),
 borrow_id text NOT NULL REFERENCES crs.borrow(id),
 action text NOT NULL CHECK(action IN ('BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN')),
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 UNIQUE(user_id,history_id)
);
CREATE INDEX notifications_inbox ON crs.notifications(user_id,created_at DESC);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['password_credentials','password_challenges','security_mail','equipment_visibility','notifications'] LOOP
   EXECUTE format('ALTER TABLE crs.%I ENABLE ROW LEVEL SECURITY',name);
   EXECUTE format('REVOKE ALL ON crs.%I FROM PUBLIC',name);
   IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
     EXECUTE format('REVOKE ALL ON crs.%I FROM anon,authenticated',name);
   END IF;
 END LOOP;
END $$;
COMMIT;
