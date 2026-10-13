/**
 * Converts a compare() result into a SARIF v2.1.0 log for GitHub Code Scanning.
 * One rule per severity; each finding becomes a result anchored to the candidate schema file,
 * with its JSON Pointer as the logical location.
 */
const RULES = [
  { id: 'breaking', level: 'error', text: 'A rule became more restrictive, so data the baseline accepted can now be rejected.' },
  { id: 'review', level: 'warning', text: 'The effect of this change needs a human decision.' },
  { id: 'compatible', level: 'note', text: 'A recognized rule became more permissive.' },
];

/** Best-effort line of a JSON Pointer in the candidate file text: finds each key in order. Minified files resolve to line 1. */
export function pointerLine(text, pointer) {
  let at = 0;
  for (const token of pointer.split('/').slice(1).map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (/^\d+$/.test(token)) continue;
    const next = text.indexOf(JSON.stringify(token), at);
    if (next < 0) break;
    at = next;
  }
  return text.slice(0, at).split('\n').length;
}

export function toSarif(result, { candidateUri, candidateText = '', version = '1.0.0' }) {
  const uri = candidateUri.replace(/\\/g, '/');
  return {
    $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'schemalabs',
          version,
          informationUri: 'https://schemalabs.co.uk/docs.html',
          rules: RULES.map(rule => ({
            id: rule.id,
            name: rule.id[0].toUpperCase() + rule.id.slice(1) + 'SchemaChange',
            shortDescription: { text: `${rule.id[0].toUpperCase() + rule.id.slice(1)} schema change` },
            fullDescription: { text: rule.text },
            defaultConfiguration: { level: rule.level },
          })),
        },
      },
      results: result.changes.map(change => {
        const ruleIndex = RULES.findIndex(rule => rule.id === change.severity);
        return {
          ruleId: change.severity,
          ruleIndex,
          level: RULES[ruleIndex].level,
          message: { text: `${change.path}: ${change.message}` },
          locations: [{
            physicalLocation: { artifactLocation: { uri }, region: { startLine: pointerLine(candidateText, change.path) } },
            logicalLocations: [{ fullyQualifiedName: change.path, kind: 'member' }],
          }],
          properties: { kind: change.kind, pointer: change.path },
        };
      }),
    }],
  };
}
