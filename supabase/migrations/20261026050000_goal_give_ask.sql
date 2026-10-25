-- Two moves instead of five goals: "give" (make intros) or "ask" (ask for meetings and intros).
-- Older goals all become "ask". Until this runs, the app stores "ask" as "referrals" (src/lib/profile.ts).
alter table profiles drop constraint if exists profiles_goal_check;
update profiles set goal = 'ask' where goal in ('clients', 'referrals', 'winback', 'partners');
alter table profiles add constraint profiles_goal_check check (goal in ('give', 'ask'));
