-- The interval used to be how often a phone on the move reported, and half a
-- minute was the default. It is now how often the server pings each phone,
-- and half a minute as a ping is a push a minute all day. Anything under the
-- two minute floor goes to the five minute default, anything over the ten
-- minute ceiling to the ceiling, and a value that is not a number at all to
-- the default.
UPDATE "circles"
SET "settings" = jsonb_set(
  "settings",
  '{minUpdateIntervalSeconds}',
  CASE
    WHEN jsonb_typeof("settings"->'minUpdateIntervalSeconds') <> 'number' THEN '300'::jsonb
    WHEN ("settings"->>'minUpdateIntervalSeconds')::numeric < 120 THEN '300'::jsonb
    ELSE '600'::jsonb
  END
)
WHERE "settings" ? 'minUpdateIntervalSeconds'
  AND CASE
    WHEN jsonb_typeof("settings"->'minUpdateIntervalSeconds') <> 'number' THEN true
    ELSE ("settings"->>'minUpdateIntervalSeconds')::numeric NOT BETWEEN 120 AND 600
  END;
