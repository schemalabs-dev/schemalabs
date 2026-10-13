#!/usr/bin/env node
// Compare two JSON Schema files from the terminal. Exit 0: no breaking change, 1: breaking change found, 2: usage or input error.
import { readFile } from 'node:fs/promises';
import { compare } from '../src/engine.js';
import { toSarif } from '../src/sarif.js';

const usage = 'Usage: schemalabs --baseline <schema.json> --candidate <schema.json> [--format text|json|sarif] [--json]';
const fail = message => { console.error(`schemalabs: ${message}\n${usage}`); process.exit(2); };

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
const options = { format: 'text' };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') options.format = 'json';
  else if (arg === '--baseline' || arg === '--candidate' || arg === '--format') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`${arg} needs a value`);
    options[arg.slice(2)] = args[++i];
  } else fail(`unknown argument ${arg}`);
}
if (!options.baseline || !options.candidate) fail('both --baseline and --candidate are required');
if (!['text', 'json', 'sarif'].includes(options.format)) fail(`unknown format ${options.format}`);

const load = async (file, label) => {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { fail(`cannot read ${label} schema ${file}: ${error.message}`); }
  try { return { text, schema: JSON.parse(text) }; } catch (error) { fail(`${label} schema ${file} is not valid JSON: ${error.message}`); }
};
const before = await load(options.baseline, 'baseline');
const after = await load(options.candidate, 'candidate');

let result;
try { result = compare(before.schema, after.schema); } catch (error) { fail(`invalid schema: ${error.message}`); }

if (options.format === 'json') console.log(JSON.stringify(result, null, 2));
else if (options.format === 'sarif') {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify(toSarif(result, { candidateUri: options.candidate, candidateText: after.text, version }), null, 2));
} else {
  for (const change of result.changes) console.log(`${change.severity.toUpperCase().padEnd(10)} ${change.path}  ${change.message}`);
  console.log(`${result.changes.length ? '\n' : ''}${result.breaking} breaking, ${result.review} review, ${result.compatible} compatible`);
}
process.exit(result.breaking ? 1 : 0);
