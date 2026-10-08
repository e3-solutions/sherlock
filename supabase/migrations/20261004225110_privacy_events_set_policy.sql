set local lock_timeout='90s';
alter policy sherlock_product_reader on telemetry.events using (
 case when (select sherlock_access.private_principal())
 then source_record_id in (select sherlock_access.protected_record_ids()) and (session_id is null or session_id in (select sherlock_access.private_session_ids())) and (related_session_id is null or related_session_id in (select sherlock_access.private_session_ids()))
 else source_record_id not in (select sherlock_access.protected_record_ids()) and (session_id is null or session_id not in (select sherlock_access.hidden_session_ids())) and (related_session_id is null or related_session_id not in (select sherlock_access.hidden_session_ids())) end);
