from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "validate_bundle.py"
SPEC = importlib.util.spec_from_file_location("bonaparte_alerting", MODULE_PATH)
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


class AlertingBundleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.bundle = validator.load_bundle()

    def mutate_rule(self, uid: str) -> dict:
        return next(rule for rule in self.bundle["rules"]["rules"] if rule["uid"] == uid)

    def test_checked_in_bundle_is_valid(self) -> None:
        validator.validate_bundle_data(self.bundle)

    def test_bundle_fingerprint_is_deterministic_and_change_sensitive(self) -> None:
        first = validator.bundle_fingerprints(self.bundle)
        second = validator.bundle_fingerprints(validator.load_bundle())
        self.assertEqual(first, second)
        self.mutate_rule("bonaparte-dashboard-unavailable")["for"] = "3m"
        self.assertNotEqual(first["rules"], validator.bundle_fingerprints(self.bundle)["rules"])

    def test_every_new_rule_starts_paused(self) -> None:
        self.bundle["rules"]["defaults"]["is_paused"] = False
        with self.assertRaisesRegex(validator.BundleError, "default paused"):
            validator.validate_bundle_data(self.bundle)

    def test_rule_inventory_is_pinned(self) -> None:
        extra = copy.deepcopy(self.bundle["rules"]["rules"][0])
        extra["uid"] = "bonaparte-extra-noise"
        self.bundle["rules"]["rules"].append(extra)
        with self.assertRaisesRegex(validator.BundleError, "inventory changed"):
            validator.validate_bundle_data(self.bundle)

    def test_missing_severity_or_description_is_rejected(self) -> None:
        self.mutate_rule("bonaparte-dashboard-unavailable")["severity"] = ""
        with self.assertRaisesRegex(validator.BundleError, "invalid severity"):
            validator.validate_bundle_data(self.bundle)

        self.bundle = validator.load_bundle()
        self.mutate_rule("bonaparte-dashboard-unavailable")["description"] = ""
        with self.assertRaisesRegex(validator.BundleError, "no description"):
            validator.validate_bundle_data(self.bundle)

    def test_freshness_rule_is_gated_on_dashboard_health(self) -> None:
        rule = self.mutate_rule("bonaparte-pipeline-freshness")
        rule["expr"] = rule["expr"].replace("bonaparte-production-healthz", "unrelated")
        with self.assertRaisesRegex(validator.BundleError, "gated"):
            validator.validate_bundle_data(self.bundle)

    def test_http_contract_rejects_unhealthy_health_response(self) -> None:
        check = self.bundle["synthetics"]["checks"][0]
        self.assertTrue(validator.evaluate_http_contract(check, 200, {}, '{"status":"ok"}'))
        self.assertFalse(validator.evaluate_http_contract(check, 503, {}, '{"status":"ok"}'))
        self.assertFalse(validator.evaluate_http_contract(check, 200, {}, '{"status":"unavailable"}'))

    def test_freshness_contract_rejects_delay_and_stale_cache(self) -> None:
        check = self.bundle["synthetics"]["checks"][1]
        hit = {"X-Sherlock-Freshness-Cache": "hit"}
        stale = {"X-Sherlock-Freshness-Cache": "stale"}
        self.assertTrue(validator.evaluate_http_contract(check, 200, hit, '{"delayed":false}'))
        self.assertFalse(validator.evaluate_http_contract(check, 200, hit, '{"delayed":true}'))
        self.assertFalse(validator.evaluate_http_contract(check, 200, stale, '{"delayed":false}'))
        self.assertFalse(validator.evaluate_http_contract(check, 200, {}, '{"delayed":false}'))

    def test_probe_quorum_filters_one_region_failure(self) -> None:
        self.assertFalse(validator.failed_probe_quorum([True, True, True]))
        self.assertFalse(validator.failed_probe_quorum([True, True, False]))
        self.assertTrue(validator.failed_probe_quorum([True, False, False]))

    def test_freshness_is_suppressed_during_dashboard_outage(self) -> None:
        self.assertTrue(validator.freshness_alert_condition([True, False, False], [True, True, True]))
        self.assertFalse(validator.freshness_alert_condition([True, False, False], [False, False, True]))

    def test_routing_is_exact_and_unmatched_falls_through(self) -> None:
        production = {
            "service": "bonaparte",
            "environment": "production",
            "owner": "bonaparte",
            "severity": "critical",
        }
        receiver = "Bonaparte Production Slack"
        self.assertEqual(
            self.bundle["routing"]["policy_subtree"]["unmatched_behavior"],
            "inherit_existing_default_receiver",
        )
        self.assertEqual(validator.route_receiver(self.bundle["routing"], production), receiver)
        self.assertEqual(
            validator.route_receiver(self.bundle["routing"], {**production, "severity": "warning"}),
            receiver,
        )
        for labels in (
            {**production, "service": "shield"},
            {**production, "environment": "staging"},
            {**production, "owner": "another-team"},
            {**production, "severity": "info"},
            {key: value for key, value in production.items() if key != "severity"},
        ):
            self.assertIsNone(validator.route_receiver(self.bundle["routing"], labels))

    def test_broad_warning_matcher_is_rejected(self) -> None:
        warning = self.bundle["routing"]["policy_subtree"]["routes"][1]
        warning["matchers"] = ["severity != critical"]
        with self.assertRaisesRegex(validator.BundleError, "exact matchers"):
            validator.validate_bundle_data(self.bundle)

    def test_resolved_notification_and_recovery_template_are_required(self) -> None:
        self.bundle["routing"]["contact_points"][0]["disable_resolve_message"] = True
        with self.assertRaisesRegex(validator.BundleError, "Resolved notifications"):
            validator.validate_bundle_data(self.bundle)

        self.bundle = validator.load_bundle()
        self.bundle["template"] = self.bundle["template"].replace(".Alerts.Resolved", ".Alerts.Firing")
        with self.assertRaisesRegex(validator.BundleError, "Alerts.Resolved"):
            validator.validate_bundle_data(self.bundle)

    def test_common_annotations_and_alert_rule_tokens_are_rejected(self) -> None:
        self.bundle["template"] += "\n{{ .CommonAnnotations.description }}"
        with self.assertRaisesRegex(validator.BundleError, "unsafe token"):
            validator.validate_bundle_data(self.bundle)

    def test_credential_like_values_are_rejected(self) -> None:
        self.bundle["routing"]["contact_points"][0]["settings"]["url"] = (
            "https://hooks.slack.com/services/example/secret/value"
        )
        with self.assertRaisesRegex(validator.BundleError, "credential-like"):
            validator.validate_bundle_data(self.bundle)

if __name__ == "__main__":
    unittest.main()
