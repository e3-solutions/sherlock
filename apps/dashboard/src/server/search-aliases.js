const ALIASES = new Map([
  ["paddleocr", ["paddle", '"PP-OCRv6"']],
  ["paddle", ["paddleocr", '"PP-OCRv6"']],
  ["ppocrv6", ["paddleocr", "paddle", '"PP-OCRv6"']],
]);

const MAX_QUERY_CODEPOINTS = 256;
const MAX_EXPANSION_NODES = 31;

/**
 * Add bounded, deterministic OR branches for a small family of search terms.
 * The caller can disable this when exact query semantics are required.
 */
export function expandSearchAliases(query, enabled = false) {
  if (typeof query !== "string" || !enabled) return query;

  let codepoints = 0;
  for (const _point of query) {
    codepoints += 1;
    if (codepoints > MAX_QUERY_CODEPOINTS) return query;
  }

  // Keep the parser intentionally narrow: quotes, operators and punctuation
  // may carry meaning to the search backend and must retain exact semantics.
  if (!/^[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)*$/.test(query)) return query;

  const terms = query.split(/\s+/);
  if (terms.some((term) => term.toLowerCase() === "or")) return query;
  const choices = [];
  let branchCount = 1;
  for (const term of terms) {
    const alternatives = ALIASES.get(term.toLowerCase());
    const termChoices = alternatives
      ? [term, ...alternatives].map((text) => ({ text, extraNodes: text.startsWith('"') ? 4 : 0 }))
      : [{ text: term, extraNodes: 0 }];
    choices.push(termChoices);
    branchCount *= termChoices.length;
  }
  let phraseNodeOverhead = 0;
  for (const termChoices of choices) {
    const choiceCount = termChoices.length;
    const phraseCost = termChoices.reduce((sum, choice) => sum + choice.extraNodes, 0);
    phraseNodeOverhead += phraseCost * (branchCount / choiceCount);
  }
  const nodeCount = 2 * branchCount * terms.length - 1 + phraseNodeOverhead;
  if (nodeCount > MAX_EXPANSION_NODES) return query;
  if (branchCount === 1) return query;

  const branches = [];
  const seen = new Set();
  function visit(index, parts) {
    if (index === choices.length) {
      const branch = parts.join(" ");
      if (!seen.has(branch)) {
        seen.add(branch);
        branches.push(branch);
      }
      return;
    }
    for (const choice of choices[index]) visit(index + 1, [...parts, choice.text]);
  }

  visit(0, []);
  // Preserve the caller's exact spelling and spacing as the first branch.
  const normalizedOriginal = terms.join(" ");
  const ordered = [query, ...branches.filter((branch) => branch !== normalizedOriginal)];
  const expanded = ordered.join(" OR ");
  let expandedCodepoints = 0;
  for (const _point of expanded) {
    expandedCodepoints += 1;
    if (expandedCodepoints > MAX_QUERY_CODEPOINTS) return query;
  }
  return expanded;
}
