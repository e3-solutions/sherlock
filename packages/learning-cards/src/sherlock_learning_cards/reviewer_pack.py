"""Render a local-only HTML review pack for private learning-card drafts.

The review pack is deliberately static: it contains no links, scripts, network
requests, persistence, or publication mechanism.  Decision controls are a
human-review aid only; a later, separately-owned workflow may record a review.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from html import escape
from typing import Any

from .contract import build_reviewer_brief


class ReviewerPackError(ValueError):
    """A review pack cannot safely represent the supplied card collection."""


def render_reviewer_pack(
    cards: Iterable[Mapping[str, Any]], *, title: str = "Private learning-card review"
) -> str:
    """Return deterministic, self-contained HTML for local human review.

    Cards are validated through the learning-card contract before anything is
    rendered.  They are ordered by ID so that the same drafts produce identical
    output regardless of input order.
    """

    if not isinstance(title, str) or not title.strip():
        raise ReviewerPackError("title must be a non-empty string")

    briefs = [build_reviewer_brief(card) for card in cards]
    card_ids = [brief["card_id"] for brief in briefs]
    if len(card_ids) != len(set(card_ids)):
        raise ReviewerPackError("each review-pack card_id must be unique")
    briefs.sort(key=lambda brief: brief["card_id"])

    escaped_title = _text(title)
    cards_html = "\n".join(_render_card(brief) for brief in briefs)
    if not cards_html:
        cards_html = '<p class="empty">No cards were supplied for review.</p>'

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>{escaped_title}</title>
  <style>
    :root {{ color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #17202a; }}
    body {{ margin: 0; }}
    main {{ max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }}
    h1 {{ margin: 0 0 8px; }}
    h2 {{ margin: 0; font-size: 1.25rem; }}
    .notice {{ border-left: 5px solid #795000; background: #fff6d9; padding: 16px; margin: 24px 0; }}
    .notice p {{ margin: 6px 0 0; }}
    article {{ background: #fff; border: 1px solid #d8dee8; border-radius: 10px; padding: 24px; margin: 22px 0; box-shadow: 0 1px 2px #17202a0d; }}
    .card-meta {{ color: #536272; font-size: .9rem; margin: 8px 0 0; }}
    dl {{ display: grid; grid-template-columns: minmax(140px, 1fr) 4fr; gap: 12px 20px; margin: 22px 0; }}
    dt {{ font-weight: 650; }}
    dd {{ margin: 0; white-space: pre-wrap; }}
    ul {{ padding-left: 22px; }}
    li {{ margin: 8px 0; }}
    table {{ border-collapse: collapse; width: 100%; font-size: .93rem; }}
    th, td {{ border: 1px solid #d8dee8; padding: 9px; text-align: left; vertical-align: top; }}
    th {{ background: #f1f4f8; }}
    code {{ overflow-wrap: anywhere; }}
    fieldset {{ border: 1px solid #b8c4d3; border-radius: 7px; margin: 26px 0 0; padding: 16px; }}
    legend {{ font-weight: 650; padding: 0 6px; }}
    label {{ display: block; margin: 10px 0; }}
    input[type="text"], textarea {{ box-sizing: border-box; display: block; width: 100%; margin-top: 5px; padding: 8px; border: 1px solid #9dabba; border-radius: 4px; font: inherit; }}
    textarea {{ min-height: 72px; resize: vertical; }}
    .helper, .empty {{ color: #536272; }}
  </style>
</head>
<body>
  <main>
    <h1>{escaped_title}</h1>
    <section class="notice" aria-label="Privacy and storage notice">
      <strong>Private review only.</strong>
      <p>This self-contained file makes no network requests and has no publish, submit, or save action. Its decision fields stay in this browser until a reviewer records the outcome through a separate private process. Do not add raw session, customer, recording, or transcript content.</p>
    </section>
    {cards_html}
  </main>
</body>
</html>
"""


def _render_card(brief: Mapping[str, Any]) -> str:
    card_id = str(brief["card_id"])
    token = hashlib.sha256(card_id.encode("utf-8")).hexdigest()[:16]
    attempts = "".join(
        "<li><strong>Approach:</strong> "
        f"{_text(attempt['approach'])} "
        f"<strong>Result:</strong> {_text(attempt['result'])}</li>"
        for attempt in brief["attempts"]
    )
    reuse_when = "".join(f"<li>{_text(item)}</li>" for item in brief["reuse_when"])
    evidence = "".join(
        "<tr>"
        f"<td>{_text(item['kind'])}</td>"
        f"<td><code>{_text(item['reference'])}</code></td>"
        f"<td>{_text(', '.join(item['supports']))}</td>"
        f"<td>{_text(item['verification'])}</td>"
        "</tr>"
        for item in brief["evidence"]
    )
    review_questions = "".join(
        f"<li>{_text(question)}</li>" for question in brief["review_questions"]
    )

    return f"""    <article aria-labelledby="card-{token}">
      <h2 id="card-{token}">{_text(card_id)}</h2>
      <p class="card-meta">Status: {_text(brief["status"])} · Visibility: private · Confidence: {_text(brief["confidence"])}</p>
      <dl>
        <dt>Problem</dt>
        <dd>{_text(brief["problem"])}</dd>
        <dt>Learning</dt>
        <dd>{_text(brief["learning"])}</dd>
      </dl>
      <h3>What was tried</h3>
      <ul>{attempts}</ul>
      <h3>When to reuse</h3>
      <ul>{reuse_when}</ul>
      <h3>Evidence references</h3>
      <table>
        <thead><tr><th scope="col">Kind</th><th scope="col">Private reference</th><th scope="col">Supports</th><th scope="col">Verification</th></tr></thead>
        <tbody>{evidence}</tbody>
      </table>
      <h3>Review prompts</h3>
      <ul>{review_questions}</ul>
      <fieldset aria-describedby="review-note-{token}">
        <legend>Reviewer decision — not saved by this page</legend>
        <label><input type="radio" name="decision-{token}" value="approved"> Approved: accurate and useful enough to reuse.</label>
        <label><input type="radio" name="decision-{token}" value="needs_evidence"> Needs evidence: potentially useful, but proof is insufficient.</label>
        <label><input type="radio" name="decision-{token}" value="rejected"> Rejected: not useful, not accurate, or too broad.</label>
        <label for="reviewer-{token}">Reviewer (optional)<input id="reviewer-{token}" type="text" autocomplete="off"></label>
        <label for="review-note-{token}">Reason or missing evidence (optional)<textarea id="review-note-{token}" autocomplete="off"></textarea></label>
        <p class="helper">Record the chosen decision in the separately approved private review process; this page cannot send it anywhere.</p>
      </fieldset>
    </article>"""


def _text(value: object) -> str:
    return escape(str(value), quote=True)
