BEGIN;
-- Calendar-derived reminders are not custody History events.
ALTER TABLE crs.notifications ALTER COLUMN history_id DROP NOT NULL;
ALTER TABLE crs.notifications ADD COLUMN reminder_due_date date;
ALTER TABLE crs.notifications ADD COLUMN reminder_day date;
ALTER TABLE crs.notifications DROP CONSTRAINT notifications_action_check;
ALTER TABLE crs.notifications ADD CONSTRAINT notifications_action_check CHECK(action IN ('BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN','DUE_SOON','OVERDUE'));
ALTER TABLE crs.notifications ADD CONSTRAINT notifications_source_check CHECK (
 (action IN ('DUE_SOON','OVERDUE') AND history_id IS NULL AND reminder_due_date IS NOT NULL AND reminder_day IS NOT NULL)
 OR (action NOT IN ('DUE_SOON','OVERDUE') AND history_id IS NOT NULL AND reminder_due_date IS NULL AND reminder_day IS NULL));
CREATE UNIQUE INDEX notifications_reminder_once ON crs.notifications(user_id,borrow_id,action,reminder_due_date,reminder_day) WHERE history_id IS NULL;
ALTER TABLE crs.notification_preferences DROP CONSTRAINT notification_preferences_event_check;
ALTER TABLE crs.notification_preferences ADD CONSTRAINT notification_preferences_event_check CHECK(event IN ('BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN','ADMIN_BORROW_REQUEST','ADMIN_REQUEST_RETURN','DUE_SOON','OVERDUE'));
ALTER TABLE crs.notification_delivery ADD CONSTRAINT notification_delivery_event_check CHECK(event IN ('BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN','ADMIN_BORROW_REQUEST','ADMIN_REQUEST_RETURN','DUE_SOON','OVERDUE'));
CREATE INDEX borrow_reminder_candidates ON crs.borrow((data->>'due_date'),id) WHERE status IN ('CHECKED_OUT','RETURN_REQUESTED');
COMMIT;
