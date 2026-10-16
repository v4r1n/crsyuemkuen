BEGIN;
ALTER TABLE crs.notification_preferences ADD COLUMN external_channel text
  CHECK (external_channel IN ('PUSH','EMAIL'));

-- Opt-in device capabilities are transient session proofs, not business data.
CREATE TABLE crs.push_subscriptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES crs.users(id),
  origin text NOT NULL,
  session_hash text NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(origin,endpoint)
);
CREATE INDEX push_subscriptions_owner ON crs.push_subscriptions(user_id,origin,expires_at);

-- Operational attempts only: never replay a restored historical notice.
CREATE TABLE crs.notification_delivery (
  id text PRIMARY KEY,
  notification_id text NOT NULL REFERENCES crs.notifications(id),
  user_id text NOT NULL REFERENCES crs.users(id),
  origin text NOT NULL,
  event text NOT NULL,
  channel text NOT NULL CHECK(channel IN ('PUSH','EMAIL')),
  subscription_id text,
  recipient_digest text NOT NULL,
  preference_version integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','SENDING','ACCEPTED','FAILED','UNCERTAIN','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_delivery_due ON crs.notification_delivery(origin,available_at,id) WHERE status='PENDING';
CREATE INDEX notification_delivery_sending ON crs.notification_delivery(origin,started_at) WHERE status='SENDING';
ALTER TABLE crs.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crs.notification_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crs.push_subscriptions,crs.notification_delivery FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON crs.push_subscriptions,crs.notification_delivery FROM anon,authenticated;
  END IF;
END $$;
COMMIT;
