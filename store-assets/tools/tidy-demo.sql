-- date_trunc is in the session's time zone; run it with PGTZ set to the
-- simulator's zone (Asia/Karachi here).
-- Run after seed-demo.mjs. The feed should read like a family's morning,
-- not like the seeder's setup: no "added the place" or "joined" lines, and
-- the check-in and the quick message dated when they would have happened.
delete from events where type in ('place_created', 'member_joined');
update events set occurred_at = date_trunc('day', now()) + interval '8 hours 3 minutes',
                  created_at  = date_trunc('day', now()) + interval '8 hours 3 minutes'
 where type = 'check_in';
update events set occurred_at = date_trunc('day', now()) + interval '8 hours 1 minutes',
                  created_at  = date_trunc('day', now()) + interval '8 hours 1 minutes'
 where type = 'nudge_requested';
-- History is hidden from before a member joined, and the seeder joined
-- everyone a moment ago. A family has been a family for longer.
update circle_members set created_at = now() - interval '90 days';
-- The seeder has David at home overnight with hourly fixes after the gym,
-- and the detector reads the gap as one slow walk home. Nobody's history
-- has a 45 minute, 6 km/h "trip" in it.
delete from events where type = 'trip_completed' and summary like '%from Gym to Home%';
update location_points set trip_id = null
 where trip_id in (select t.id from trips t join places p on p.id = t.start_place_id where p.name = 'Gym');
delete from trips where start_place_id in (select id from places where name = 'Gym');
