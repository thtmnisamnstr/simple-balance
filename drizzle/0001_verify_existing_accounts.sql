-- Every account that exists right now was created before this deployment could
-- ask anybody to confirm an address, so every one of them has email_verified
-- false. Address verification is required from the moment a mail server is
-- configured, and it gates signing in: without this, the day an operator sets
-- SMTP_URL is the day everybody who already had an account stops being able to
-- open it. They were admitted under the rules that applied at the time, so they
-- keep what they were given.
UPDATE "auth_user" SET "email_verified" = true WHERE "email_verified" = false;
