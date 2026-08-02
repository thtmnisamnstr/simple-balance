-- Runs once, the first time the development database container initialises.
--
-- The integration suite needs a database of its own so it can be reset without
-- touching whatever you have been working with. Creating it here means
-- `npm run test:integration` works straight after `docker compose up` instead
-- of failing on a database you were never told to create.
CREATE DATABASE simple_balance_test;
