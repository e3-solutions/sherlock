set local lock_timeout='90s';
alter policy sherlock_product_reader on telemetry.session_scm using (
 case when (select sherlock_access.private_principal())
 then session_id in (select sherlock_access.private_session_ids()) and source_record_id in (select sherlock_access.protected_record_ids())
 else session_id not in (select sherlock_access.hidden_session_ids()) and source_record_id not in (select sherlock_access.protected_record_ids()) end);
