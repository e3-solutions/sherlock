-- Preserve the deployed freshness implementation and its access controls.
DO $migration$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('analytics.read_dashboard_freshness(uuid,text,text[],integer)'::regprocedure) INTO definition;
  IF position('p_expected_email_domain in (''e3group.ai'', ''sixtyfour.ai'')' in definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected dashboard freshness domain guard; review before migrating';
  END IF;
  EXECUTE replace(definition,
    'p_expected_email_domain in (''e3group.ai'', ''sixtyfour.ai'')',
    'p_expected_email_domain in (''e3group.ai'', ''sixtyfour.ai'', ''bigballerbrandwheels.com'')');
END
$migration$;
