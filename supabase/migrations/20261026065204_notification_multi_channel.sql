BEGIN;
-- Widen only the preference check: existing opt-ins and per-channel jobs stay intact.
ALTER TABLE crs.notification_preferences
  DROP CONSTRAINT notification_preferences_external_channel_check,
  ADD CONSTRAINT notification_preferences_external_channel_check
    CHECK (external_channel IN ('PUSH','EMAIL','PUSH_EMAIL'));
COMMIT;
