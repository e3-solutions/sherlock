set local lock_timeout='90s';
alter policy sherlock_product_reader on analytics.frame_projection_receipts using (
 case when (select sherlock_access.private_principal())
 then person_id in (select sherlock_access.protected_person_ids()) and session_id in (select sherlock_access.private_session_ids())
 else person_id not in (select sherlock_access.protected_person_ids()) and session_id not in (select sherlock_access.hidden_session_ids()) end);
