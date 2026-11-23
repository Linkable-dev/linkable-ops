-- The outreach rounds are started from here, on the minute.
--
-- Vercel's own timer only promises "some time within the hour": on
-- 23 Nov 2026 rounds started 7, 20+ and 52 minutes late. This one calls the
-- same endpoint at 09:10, 11:10, 13:10 and 15:10 UTC, Monday to Friday.
-- Vercel's stays as a backup; the endpoint lets only the first of the two
-- send (direct_send_last_round in prospector_settings).
--
-- The endpoint's secret is not in this file. It lives in the vault under the
-- name ops_cron_secret:
--   select vault.create_secret('<CRON_SECRET>', 'ops_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.run_direct_outreach() returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'ops_cron_secret';
  if secret is null then
    raise exception 'ops_cron_secret is not in the vault';
  end if;
  return net.http_get(
    url := 'https://linkable-ops.vercel.app/api/cron/direct-outreach',
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 60000
  );
end $$;

revoke all on function public.run_direct_outreach() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'direct-outreach';
select cron.schedule('direct-outreach', '10 9,11,13,15 * * 1-5', 'select public.run_direct_outreach()');
