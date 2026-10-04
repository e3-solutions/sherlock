set local lock_timeout='90s';
alter policy sherlock_product_reader on telemetry.native_records using (
 case when (select sherlock_access.private_principal())
 then batch_id in (select sherlock_access.protected_batch_ids())
 else batch_id not in (select sherlock_access.protected_batch_ids()) end);
