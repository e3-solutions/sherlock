set local lock_timeout='90s';
alter policy sherlock_product_reader on telemetry.sessions using (
 case when (select sherlock_access.private_principal())
 then id in (select sherlock_access.private_session_ids())
 else id not in (select sherlock_access.hidden_session_ids()) end);
