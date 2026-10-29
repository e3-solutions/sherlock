#!/usr/bin/env python3
"""Validate and simulate the source-controlled Bonaparte alerting contract."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


GRAFANA_DIR = Path(__file__).resolve().parent
RAILWAY_FILE = GRAFANA_DIR.parent / "railway" / "alerts.json"

EXPECTED_RULES = {
    "bonaparte-dashboard-unavailable",
    "bonaparte-pipeline-freshness",
    "bonaparte-synthetic-telemetry-missing",
    "bonaparte-supabase-telemetry-missing",
    "bonaparte-supabase-pool-waiting",
}
EXPECTED_CHECKS = {
    "bonaparte-production-healthz",
    "bonaparte-production-freshness",
}
EXPECTED_DEFAULT_LABELS = {
    "service": "bonaparte",
    "environment": "production",
    "owner": "bonaparte",
}
EXPECTED_PARENT_MATCHERS = {
    "service = bonaparte",
    "environment = production",
    "owner = bonaparte",
}
EXPECTED_GROUP_BY = ["alertname", "component"]
FORBIDDEN_SECRET_PATTERNS = (
    re.compile(r"https://hooks\.slack\.com/services/", re.IGNORECASE),
    re.compile(r"\bsb_secret_[A-Za-z0-9_-]+"),
    re.compile(r"\bglc_[A-Za-z0-9_-]+"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~-]+", re.IGNORECASE),
)
FORBIDDEN_TEMPLATE_TOKENS = (
    ".CommonAnnotations",
    "$labels",
    "$value",
    "$values",
    "$startsAt",
)


class BundleError(RuntimeError):
    """Raised when desired alert state is unsafe or internally inconsistent."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BundleError(message)


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BundleError(f"Cannot read {path}: {exc}") from exc
    require(isinstance(value, dict), f"{path} must contain a JSON object")
    return value


def load_bundle(base_dir: Path = GRAFANA_DIR) -> dict[str, Any]:
    return {
        "rules": read_json(base_dir / "alert-rules.json"),
        "synthetics": read_json(base_dir / "synthetic-checks.json"),
        "routing": read_json(base_dir / "notification-routing.json"),
        "railway": read_json(base_dir.parent / "railway" / "alerts.json"),
        "template": (base_dir / "notification_templates" / "bonaparte_slack_message.tmpl")
        .read_text(encoding="utf-8")
        .strip(),
    }


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def validate_no_secrets(bundle: dict[str, Any]) -> None:
    for value in _strings(bundle):
        for pattern in FORBIDDEN_SECRET_PATTERNS:
            require(not pattern.search(value), "Bundle contains a credential-like value")


def merged_rule(bundle: dict[str, Any], rule: dict[str, Any]) -> dict[str, Any]:
    defaults = bundle["rules"]["defaults"]
    merged = copy.deepcopy(rule)
    merged["labels"] = {**defaults["labels"], **rule.get("labels", {})}
    merged["labels"]["component"] = rule.get("component")
    merged["labels"]["severity"] = rule.get("severity")
    merged["annotations"] = {
        **defaults["annotations"],
        "summary": rule.get("summary"),
        "description": rule.get("description"),
    }
    merged["is_paused"] = rule.get("is_paused", defaults["is_paused"])
    return merged


def validate_rules(bundle: dict[str, Any]) -> None:
    config = bundle["rules"]
    require(config.get("schema_version") == 1, "Unsupported alert-rule schema")
    defaults = config.get("defaults", {})
    require(defaults.get("is_paused") is True, "New rules must default paused")
    require(defaults.get("labels") == EXPECTED_DEFAULT_LABELS, "Default routing labels changed")
    require(defaults.get("interval") == "1m", "Rule evaluation interval must remain one minute")
    rules = config.get("rules")
    require(isinstance(rules, list), "Alert rules must be a list")
    uids = [rule.get("uid") for rule in rules if isinstance(rule, dict)]
    require(len(uids) == len(set(uids)), "Alert-rule UIDs must be unique")
    require(set(uids) == EXPECTED_RULES, "Alert-rule inventory changed; review noise and ownership")

    for raw_rule in rules:
        require(isinstance(raw_rule, dict), "Every alert rule must be an object")
        rule = merged_rule(bundle, raw_rule)
        require(rule["is_paused"] is True, f"{rule.get('uid')} is not paused")
        require(rule.get("severity") in {"critical", "warning"}, f"{rule.get('uid')} has invalid severity")
        require(bool(rule.get("component")), f"{rule.get('uid')} has no component")
        require(bool(rule.get("summary")), f"{rule.get('uid')} has no summary")
        require(bool(rule.get("description")), f"{rule.get('uid')} has no description")
        require(bool(rule.get("for")), f"{rule.get('uid')} has no duration")
        require(rule.get("no_data_state") == "OK", f"{rule.get('uid')} must explicitly treat NoData as normal; a dedicated rule owns missing telemetry")
        require(rule.get("exec_err_state") == "Error", f"{rule.get('uid')} must delegate datasource execution errors to Grafana's explicit error owner")
        require(set(rule["labels"].items()) >= set(EXPECTED_DEFAULT_LABELS.items()), f"{rule.get('uid')} can escape production routing")
        require(bool(rule["annotations"].get("runbook")), f"{rule.get('uid')} has no runbook")
        require(
            rule.get("datasource_uid") == "${GRAFANA_PROMETHEUS_DATASOURCE_UID}",
            f"{rule.get('uid')} must use the unresolved datasource UID placeholder",
        )

    by_uid = {rule["uid"]: rule for rule in rules}
    health = by_uid["bonaparte-dashboard-unavailable"]
    require(health["severity"] == "critical" and health["for"] == "2m", "Health quorum/window changed")
    require("3 - sum(max by (probe)" in health["expr"] and ">= bool 2" in health["expr"], "Health must count a missing regional series as failed")
    require("instance=\"${BONAPARTE_PRODUCTION_URL}/healthz\"" in health["expr"], "Health must use the exact synthetic target")

    freshness = by_uid["bonaparte-pipeline-freshness"]
    require(freshness["severity"] == "warning" and freshness["for"] == "5m", "Freshness severity/window changed")
    require("bonaparte-production-healthz" in freshness["expr"], "Freshness must be gated on healthy dashboard probes")
    require("3 - sum(max by (probe)" in freshness["expr"] and ">= bool 2" in freshness["expr"], "Freshness must count a missing regional series as failed")
    require("instance=\"${BONAPARTE_PRODUCTION_URL}/api/flame/freshness?refresh=wait\"" in freshness["expr"], "Freshness must use the exact synthetic target")

    missing = by_uid["bonaparte-synthetic-telemetry-missing"]
    require(missing["expr"].count("absent_over_time") == 2, "Missing-synthetic rule must cover both complete jobs")
    require(missing["severity"] == "warning" and "[10m]" in missing["expr"], "Missing-synthetic warning/window changed")
    require(missing["expr"].startswith("max("), "Missing-synthetic rule must collapse to one notification instance")
    require(missing["no_data_state"] == "OK" and missing["exec_err_state"] == "Error", "Missing-synthetic rule must own absence without generating label-changing DatasourceNoData alerts")
    require(missing["expr"].count("instance=\"") == 2, "Missing-synthetic rule must use both exact targets")

    db_missing = by_uid["bonaparte-supabase-telemetry-missing"]
    require("pg_up" in db_missing["expr"] and "pgbouncer_up" in db_missing["expr"], "Supabase missing rule must cover database and pooler")
    require("pgbouncer_pools_client_waiting_connections" in db_missing["expr"], "Supabase missing rule must own loss of the pool-wait series")
    require(db_missing["expr"].count("absent_over_time") == 3 and db_missing["expr"].startswith("max("), "Supabase missing rule must collapse all missing series to one instance")
    require("${BONAPARTE_SUPABASE_PROJECT_REF}" in db_missing["expr"], "Supabase rule lost exact project scoping")

    pool = by_uid["bonaparte-supabase-pool-waiting"]
    require("min_over_time" not in pool["expr"] and "sum(pgbouncer_pools_client_waiting_connections" in pool["expr"], "Pool pressure must use one persistence mechanism")
    require(pool["evaluator"] == "gt" and pool["threshold"] == 5, "Pool threshold changed")
    require(pool["for"] == "10m", "Pool pressure must be sustained for ten minutes")
    require(pool["no_data_state"] == "OK", "Pool NoData must be owned by the single missing-metrics rule")


def validate_synthetics(bundle: dict[str, Any]) -> None:
    config = bundle["synthetics"]
    require(config.get("schema_version") == 1, "Unsupported synthetic-check schema")
    require(config.get("template_only") is True, "Synthetic checks must be marked desired-state only")
    checks = config.get("checks")
    require(isinstance(checks, list), "Synthetic checks must be a list")
    by_job = {check.get("job"): check for check in checks if isinstance(check, dict)}
    require(set(by_job) == EXPECTED_CHECKS, "Synthetic-check inventory changed")

    for job, check in by_job.items():
        require(check.get("enabled") is False, f"{job} must start disabled")
        require(check.get("frequency_seconds") == 60, f"{job} frequency changed")
        require(check.get("timeout_seconds") == 10, f"{job} timeout changed")
        require(check.get("probes") == ["Oregon", "Ohio", "Virginia"], f"{job} probe quorum changed")
        require(check.get("labels", {}).get("service") == "bonaparte", f"{job} service scope changed")
        require(check.get("labels", {}).get("environment") == "production", f"{job} environment scope changed")
        target = check.get("target", "")
        require(target.startswith("${BONAPARTE_PRODUCTION_URL}/"), f"{job} target must use the reviewed HTTPS origin placeholder")
        http = check.get("http", {})
        require(http.get("method") == "GET", f"{job} must use GET")
        require(http.get("fail_if_not_ssl") is True, f"{job} must require TLS")
        require(http.get("valid_status_codes") == [200], f"{job} must require HTTP 200")

    health = by_job["bonaparte-production-healthz"]
    require(health["target"].endswith("/healthz"), "Health check target changed")
    require(any('"status"' in regex and '"ok"' in regex for regex in health["http"]["body_regex"]), "Health check must validate status=ok")

    freshness = by_job["bonaparte-production-freshness"]
    require(freshness["target"].endswith("/api/flame/freshness?refresh=wait"), "Freshness target changed")
    require(any('"delayed"' in regex and "false" in regex for regex in freshness["http"]["body_regex"]), "Freshness check must reject delayed receipts")
    headers = freshness["http"].get("header_regex", [])
    require(headers == [{"name": "X-Sherlock-Freshness-Cache", "pattern": "^hit$"}], "Freshness check must reject stale cached receipts")


def validate_template(bundle: dict[str, Any]) -> None:
    template = bundle["template"]
    require(bool(template), "Slack template is empty")
    for token in FORBIDDEN_TEMPLATE_TOKENS:
        require(token not in template, f"Slack template uses unsafe token {token}")
    required = (
        ".Alerts.Firing",
        ".Alerts.Resolved",
        ".Labels.alertname",
        ".Labels.severity",
        ".Labels.component",
        ".Annotations.description",
        ".Annotations.runbook",
        "No description was provided",
        "returned to normal",
        "without firing or resolved instances",
    )
    for fragment in required:
        require(fragment in template, f"Slack template is missing {fragment!r}")


def _parse_exact_matcher(matcher: str) -> tuple[str, str]:
    match = re.fullmatch(r"([a-z_]+) = ([A-Za-z0-9 _-]+)", matcher)
    require(match is not None, f"Matcher is not exact: {matcher!r}")
    return match.group(1), match.group(2)


def route_receiver(routing: dict[str, Any], labels: dict[str, str]) -> str | None:
    policy = routing["policy_subtree"]
    for raw_matcher in policy["matchers"]:
        key, value = _parse_exact_matcher(raw_matcher)
        if labels.get(key) != value:
            return None
    for route in policy["routes"]:
        if all(labels.get(key) == value for key, value in map(_parse_exact_matcher, route["matchers"])):
            return route["receiver"]
    return None


def validate_routing(bundle: dict[str, Any]) -> None:
    routing = bundle["routing"]
    require(routing.get("schema_version") == 1, "Unsupported routing schema")
    require(routing.get("template_only") is True, "Routing must be marked desired-state only")
    contacts = routing.get("contact_points")
    require(isinstance(contacts, list) and len(contacts) == 1, "Exactly one Bonaparte contact point is allowed")
    contact = contacts[0]
    require(contact.get("name") == "Bonaparte Production Slack", "Contact-point identity changed")
    require(contact.get("type") == "slack", "Contact point must be Slack")
    require(contact.get("disable_resolve_message") is False, "Resolved notifications must be enabled")
    require(contact.get("settings", {}).get("url_secret_ref") == "BONAPARTE_SLACK_WEBHOOK_URL", "Slack secret must remain an external reference")

    policy = routing.get("policy_subtree", {})
    require(policy.get("unmatched_behavior") == "inherit_existing_default_receiver", "Unmatched labels must fall through to the existing default receiver")
    require(set(policy.get("matchers", [])) == EXPECTED_PARENT_MATCHERS, "Parent route matchers changed")
    require(policy.get("group_by") == EXPECTED_GROUP_BY, "Parent grouping changed")
    routes = policy.get("routes")
    require(isinstance(routes, list) and len(routes) == 2, "Exactly two severity routes are allowed")
    by_matcher = {tuple(route.get("matchers", [])): route for route in routes}
    require(set(by_matcher) == {("severity = critical",), ("severity = warning",)}, "Severity routes must use exact matchers")
    critical = by_matcher[("severity = critical",)]
    warning = by_matcher[("severity = warning",)]
    require(critical.get("group_by") == EXPECTED_GROUP_BY, "Critical grouping changed")
    require((critical.get("group_wait"), critical.get("group_interval"), critical.get("repeat_interval")) == ("30s", "5m", "2h"), "Critical routing intervals changed")
    require(warning.get("group_by") == EXPECTED_GROUP_BY, "Warning grouping changed")
    require((warning.get("group_wait"), warning.get("group_interval"), warning.get("repeat_interval")) == ("2m", "10m", "4h"), "Warning routing intervals changed")


def validate_railway(bundle: dict[str, Any]) -> None:
    config = bundle["railway"]
    require(config.get("schema_version") == 1, "Unsupported Railway alert schema")
    require(config.get("template_only") is True, "Railway contract must be desired-state only")
    delivery = config.get("delivery", {})
    require(delivery.get("channel") == "#bonaparte-alerts", "Railway channel changed")
    require(delivery.get("direct_slack_muxer_allowed") is False, "Project-wide Railway Slack delivery must fail closed")
    require(delivery.get("send_success_events") is False, "Railway success events are noisy")
    events = {event.get("type"): event for event in config.get("events", [])}
    require(set(events) == {"Deployment.failed"}, "Only terminal failed deployment events belong in Phase 1")
    failed = events["Deployment.failed"]
    require(failed.get("desired") is True and failed.get("repeat") is False, "Terminal failed deployments must be one-shot")
    require(failed.get("environments") == ["production"], "Railway failure lost production scoping")
    require(set(failed.get("services", [])) == {"dashboard", "worker"}, "Railway failure service scope changed")
    require("deployment crashed" in config.get("explicitly_omitted", []), "Railway crash Slack must remain explicitly omitted")


def evaluate_http_contract(
    check: dict[str, Any], status: int, headers: dict[str, str], body: str
) -> bool:
    http = check["http"]
    if status not in http["valid_status_codes"]:
        return False
    if any(re.search(pattern, body) is None for pattern in http.get("body_regex", [])):
        return False
    normalized_headers = {key.lower(): value for key, value in headers.items()}
    for assertion in http.get("header_regex", []):
        value = normalized_headers.get(assertion["name"].lower(), "")
        if re.search(assertion["pattern"], value) is None:
            return False
    return True


def failed_probe_quorum(results: list[bool]) -> bool:
    require(len(results) == 3, "Probe quorum simulation requires exactly three regions")
    return sum(not result for result in results) >= 2


def freshness_alert_condition(
    freshness_results: list[bool], health_results: list[bool]
) -> bool:
    return failed_probe_quorum(freshness_results) and sum(health_results) >= 2


def bundle_fingerprints(bundle: dict[str, Any]) -> dict[str, str]:
    components = {
        "rules": bundle["rules"],
        "synthetics": bundle["synthetics"],
        "routing": bundle["routing"],
        "template": bundle["template"],
        "railway": bundle["railway"],
    }
    fingerprints: dict[str, str] = {}
    for name, value in components.items():
        normalized = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        fingerprints[name] = "sha256:" + hashlib.sha256(normalized).hexdigest()
    aggregate = json.dumps(
        fingerprints,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    fingerprints["bundle"] = "sha256:" + hashlib.sha256(aggregate).hexdigest()
    return fingerprints


def validate_bundle_data(bundle: dict[str, Any]) -> None:
    validate_no_secrets(bundle)
    validate_rules(bundle)
    validate_synthetics(bundle)
    validate_template(bundle)
    validate_routing(bundle)
    validate_railway(bundle)


def simulate(bundle: dict[str, Any]) -> dict[str, str]:
    validate_bundle_data(bundle)
    checks = {check["job"]: check for check in bundle["synthetics"]["checks"]}
    health = checks["bonaparte-production-healthz"]
    freshness = checks["bonaparte-production-freshness"]

    cases = {
        "health_ok": evaluate_http_contract(health, 200, {}, '{"status":"ok"}'),
        "health_503": evaluate_http_contract(health, 503, {}, '{"status":"unavailable"}'),
        "freshness_ok": evaluate_http_contract(
            freshness,
            200,
            {"X-Sherlock-Freshness-Cache": "hit"},
            '{"read":"2026-08-27T18:00:00.000Z","delayed":false}',
        ),
        "freshness_delayed": evaluate_http_contract(
            freshness,
            200,
            {"X-Sherlock-Freshness-Cache": "hit"},
            '{"read":"2026-08-27T18:00:00.000Z","delayed":true}',
        ),
        "freshness_stale": evaluate_http_contract(
            freshness,
            200,
            {"X-Sherlock-Freshness-Cache": "stale"},
            '{"read":"2026-08-27T18:00:00.000Z","delayed":false}',
        ),
    }
    require(cases == {
        "health_ok": True,
        "health_503": False,
        "freshness_ok": True,
        "freshness_delayed": False,
        "freshness_stale": False,
    }, "Synthetic lifecycle simulation failed")
    require(not failed_probe_quorum([True, True, True]), "Healthy probes formed a failed quorum")
    require(not failed_probe_quorum([True, True, False]), "One failed region formed a failed quorum")
    require(failed_probe_quorum([True, False, False]), "Two failed regions did not form a failed quorum")
    require(
        freshness_alert_condition([True, False, False], [True, True, True]),
        "Freshness quorum did not fire while dashboard health was good",
    )
    require(
        not freshness_alert_condition([True, False, False], [False, False, True]),
        "Freshness was not gated during dashboard outage",
    )

    production = {
        "service": "bonaparte",
        "environment": "production",
        "owner": "bonaparte",
        "severity": "critical",
    }
    require(route_receiver(bundle["routing"], production) == "Bonaparte Production Slack", "Production critical did not route")
    require(route_receiver(bundle["routing"], {**production, "severity": "warning"}) == "Bonaparte Production Slack", "Production warning did not route")
    require(route_receiver(bundle["routing"], {**production, "environment": "staging"}) is None, "Staging escaped routing boundary")
    require(route_receiver(bundle["routing"], {**production, "severity": "info"}) is None, "Unknown severity escaped routing boundary")
    missing_severity = dict(production)
    missing_severity.pop("severity")
    require(route_receiver(bundle["routing"], missing_severity) is None, "Missing severity escaped routing boundary")

    return {
        name: "passed"
        for name in (
            *cases,
            "probe_quorum",
            "freshness_health_gate",
            "routing_boundaries",
        )
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", choices=("validate", "simulate", "fingerprint"), default="validate")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        bundle = load_bundle()
        validate_bundle_data(bundle)
        result: dict[str, Any] = {
            "status": "valid",
            "rules": len(bundle["rules"]["rules"]),
            "synthetic_checks": len(bundle["synthetics"]["checks"]),
        }
        if args.command == "simulate":
            result["simulation"] = simulate(bundle)
        if args.command == "fingerprint":
            result["fingerprints"] = bundle_fingerprints(bundle)
    except (BundleError, OSError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
