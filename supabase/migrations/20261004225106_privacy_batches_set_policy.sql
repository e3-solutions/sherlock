set local lock_timeout='90s';
alter policy sherlock_product_reader on telemetry.ingest_batches using (
 case when (select sherlock_access.private_principal())
 then person_id in (select sherlock_access.protected_person_ids())
 else person_id not in (select sherlock_access.protected_person_ids()) end);
