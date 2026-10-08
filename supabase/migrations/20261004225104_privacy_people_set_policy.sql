set local lock_timeout='90s';
alter policy sherlock_product_reader on telemetry.people using (
 case when (select sherlock_access.private_principal())
 then id in (select sherlock_access.protected_person_ids())
 else id not in (select sherlock_access.protected_person_ids()) end);
