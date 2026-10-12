import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { validate, compare, baselineSchema, candidateSchema, samplePayload } from '../src/engine.js';

const object = (properties = {}, extra = {}) => ({ type: 'object', properties, ...extra });
const check = (before, after, severity, kind) => {
  const result = compare(before, after);
  assert.equal(result.breaking + result.review + result.compatible, result.changes.length);
  assert.ok(result.changes.some(item => item.severity === severity && (!kind || item.kind === kind)), JSON.stringify(result));
  for (const change of result.changes) {
    assert.equal(typeof change.path, 'string');
    assert.equal(typeof change.message, 'string');
  }
  return result;
};

test('sample schemas produce four breaking findings, with exact paths', () => {
  assert.deepEqual(compare(baselineSchema, candidateSchema), {
    changes: [
      { path: '/required/currency', severity: 'breaking', kind: 'required-added', message: 'Property "currency" is now required.' },
      { path: '/properties/status/enum', severity: 'breaking', kind: 'enum', message: 'Allowed enum values narrowed.' },
      { path: '/properties/total/type', severity: 'breaking', kind: 'type', message: 'Allowed types narrowed.' },
      { path: '/properties/total/minimum', severity: 'breaking', kind: 'constraint', message: 'minimum was tightened.' },
    ],
    breaking: 4, review: 0, compatible: 0,
  });
});
test('sample payload validates baseline and returns every candidate error', () => {
  assert.deepEqual(validate(baselineSchema, samplePayload), { valid: true, errors: [] });
  const result = validate(candidateSchema, samplePayload);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 4);
  assert.deepEqual(new Set(result.errors.map(error => error.keyword)), new Set(['required', 'enum', 'type', 'minimum']));
});
test('2020-12 prefixItems is enforced', () => {
  const schema = { type: 'array', prefixItems: [{ type: 'string' }], items: false };
  assert.equal(validate(schema, ['yes']).valid, true);
  assert.equal(validate(schema, [12]).valid, false);
  assert.equal(validate(schema, ['yes', 'extra']).valid, false);
});
test('draft-07 tuple validation is enforced', () => {
  const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'array', items: [{ type: 'string' }], additionalItems: false };
  assert.equal(validate(schema, ['yes']).valid, true);
  assert.equal(validate(schema, [12]).valid, false);
  assert.equal(validate(schema, ['yes', 'extra']).valid, false);
});
test('https draft-07 and http 2020-12 declarations are supported', () => {
  for (const $schema of ['https://json-schema.org/draft-07/schema', 'http://json-schema.org/draft/2020-12/schema#']) {
    assert.equal(validate({ $schema, type: 'integer' }, 2).valid, true);
  }
});
test('local $defs reference resolves', () => {
  const schema = { $defs: { amount: { type: 'number', minimum: 0 } }, $ref: '#/$defs/amount' };
  assert.equal(validate(schema, 2).valid, true);
  assert.equal(validate(schema, -1).valid, false);
});
test('remote references fail without fetch', () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => { fetched = true; throw new Error('Network forbidden'); };
  try {
    const result = validate({ $ref: 'https://example.invalid/private.json' }, {});
    assert.equal(result.valid, false);
    assert.match(result.error, /resolve reference/);
    assert.deepEqual(result.errors, []);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = originalFetch; }
});
test('unsupported dialect is an actionable error', () => {
  assert.match(validate({ $schema: 'https://json-schema.org/draft/2019-09/schema' }, {}).error, /Unsupported dialect/);
});
test('invalid $schema types are rejected', () => {
  assert.match(validate({ $schema: 5 }, {}).error, /string/);
});
test('invalid schemas use error result rather than payload errors', () => {
  for (const schema of [null, [], 'not a schema', 12, { type: 'nonsense' }, { required: 'bad' }, { minimum: 'one' }]) {
    const result = validate(schema, {});
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, []);
    assert.equal(typeof result.error, 'string');
  }
});
test('async schemas rejected synchronously', () => {
  assert.match(validate({ $async: true, type: 'string' }, 'yes').error, /Async schemas/);
});
test('true and false schemas validate accurately', () => {
  assert.equal(validate(true, null).valid, true);
  assert.equal(validate(false, null).valid, false);
  assert.equal(validate(false, null).errors[0].path, '/');
});
test('email and date-time formats validated', () => {
  assert.equal(validate({ type: 'string', format: 'email' }, 'a@example.com').valid, true);
  assert.equal(validate({ type: 'string', format: 'email' }, 'bad').valid, false);
  assert.equal(validate({ type: 'string', format: 'date-time' }, '2026-01-01T12:00:00Z').valid, true);
  assert.equal(validate({ type: 'string', format: 'date-time' }, 'yesterday').valid, false);
});
test('unknown custom formats ignored under strict:false', () => {
  assert.equal(validate({ type: 'string', format: 'custom-format' }, 'anything').valid, true);
});
test('allErrors includes errors from separate properties', () => {
  const result = validate(object({ a: { type: 'integer' }, b: { type: 'string', minLength: 3 } }, { required: ['c'] }), { a: '1', b: '' });
  assert.equal(result.errors.length, 3);
  assert.deepEqual(new Set(result.errors.map(error => error.path)), new Set(['/c', '/a', '/b']));
});
test('validation never coerces, defaults, or removes properties', () => {
  const schema = object({ a: { type: 'integer', default: 7 }, b: { type: 'number' } }, { additionalProperties: false });
  const payload = { b: '12', extra: true };
  const schemaCopy = structuredClone(schema);
  const payloadCopy = structuredClone(payload);
  assert.equal(validate(schema, payload).valid, false);
  assert.deepEqual(payload, payloadCopy);
  assert.deepEqual(schema, schemaCopy);
});
test('required property pointers escape slashes and tildes', () => {
  const result = validate(object({}, { required: ['a/b~c'] }), {});
  assert.equal(result.errors[0].path, '/a~1b~0c');
});
test('additional-property errors point to offending field', () => {
  const result = validate(object({}, { additionalProperties: false }), { 'a/b~c': 2 });
  assert.equal(result.errors[0].path, '/a~1b~0c');
});
test('nested array error paths retain indexes', () => {
  const result = validate(object({ rows: { type: 'array', items: object({ price: { type: 'integer' } }) } }), { rows: [{ price: 'bad' }] });
  assert.equal(result.errors[0].path, '/rows/0/price');
});
test('same $id in unrelated calls does not collide', () => {
  const $id = 'https://example.invalid/test';
  assert.equal(validate({ $id, type: 'string' }, 'a').valid, true);
  assert.equal(validate({ $id, type: 'integer' }, 'a').valid, false);
});
test('mutated schemas are recompiled instead of stale cached', () => {
  const schema = { type: 'string' };
  assert.equal(validate(schema, 'x').valid, true);
  schema.type = 'integer';
  assert.equal(validate(schema, 'x').valid, false);
});
test('identical schemas produce no findings', () => {
  assert.deepEqual(compare(baselineSchema, structuredClone(baselineSchema)), { changes: [], breaking: 0, review: 0, compatible: 0 });
});
test('annotation-only changes ignored', () => {
  assert.deepEqual(compare({ type: 'string', title: 'a', default: 'x' }, { type: 'string', title: 'b', default: 'y', description: 'info', readOnly: true }).changes, []);
});
test('object key order does not create changes', () => {
  assert.deepEqual(compare({ type: 'object', properties: { a: { type: 'string', minLength: 2 } } }, { properties: { a: { minLength: 2, type: 'string' } }, type: 'object' }).changes, []);
});
test('required additions are breaking, removals compatible', () => {
  check(object({}, { required: ['a'] }), object({}, { required: ['a', 'b'] }), 'breaking', 'required-added');
  check(object({}, { required: ['a', 'b'] }), object({}, { required: ['a'] }), 'compatible', 'required-removed');
});
test('required order alone ignored', () => {
  assert.deepEqual(compare(object({}, { required: ['a', 'b'] }), object({}, { required: ['b', 'a'] })).changes, []);
});
test('removing optional property under closed schema is breaking', () => {
  check(object({ a: { type: 'string' } }, { additionalProperties: false }), object({}, { additionalProperties: false }), 'breaking', 'property-removed');
});
test('removing open-schema property is review', () => {
  check(object({ a: { type: 'string' } }), object(), 'review', 'property-removed');
});
test('adding optional property to closed schema is compatible', () => {
  check(object({}, { additionalProperties: false }), object({ a: { type: 'string' } }, { additionalProperties: false }), 'compatible', 'property-added');
});
test('adding constrained optional property to open schema is review', () => {
  check(object(), object({ a: { type: 'string' } }), 'review', 'property-added');
});
test('adding unrestricted optional property is compatible', () => {
  check(object(), object({ a: true }), 'compatible', 'property-added');
});
test('nested fields and escaped schema pointers handled recursively', () => {
  const old = object({ 'a/b~c': object({ amount: { type: 'number' } }) });
  const next = object({ 'a/b~c': object({ amount: { type: 'integer' } }) });
  const result = check(old, next, 'breaking', 'type');
  assert.equal(result.changes[0].path, '/properties/a~1b~0c/properties/amount/type');
});
for (const [name, before, after, severity] of [
  ['number to integer', { type: 'number' }, { type: 'integer' }, 'breaking'],
  ['integer to number', { type: 'integer' }, { type: 'number' }, 'compatible'],
  ['nullable union removal', { type: ['string', 'null'] }, { type: 'string' }, 'breaking'],
  ['nullable union addition', { type: 'string' }, { type: ['string', 'null'] }, 'compatible'],
  ['type introduction', {}, { type: 'string' }, 'breaking'],
  ['type removal', { type: 'string' }, {}, 'compatible'],
  ['unrelated types', { type: 'string' }, { type: 'integer' }, 'review'],
]) test(`types: ${name}`, () => check(before, after, severity, 'type'));
test('union order and number-plus-integer redundancy ignored', () => {
  assert.deepEqual(compare({ type: ['string', 'number'] }, { type: ['integer', 'number', 'string'] }).changes, []);
});
for (const [name, before, after, severity] of [
  ['narrowed', { enum: ['a', 'b'] }, { enum: ['a'] }, 'breaking'],
  ['widened', { enum: ['a'] }, { enum: ['a', 'b'] }, 'compatible'],
  ['introduced', {}, { enum: ['a'] }, 'breaking'],
  ['removed', { enum: ['a'] }, {}, 'compatible'],
  ['replaced', { enum: ['a', 'b'] }, { enum: ['b', 'c'] }, 'review'],
]) test(`enum: ${name}`, () => check(before, after, severity, 'enum'));
test('enum object key order and value ordering ignored', () => {
  assert.deepEqual(compare({ enum: [{ a: 1, b: 2 }, null] }, { enum: [null, { b: 2, a: 1 }] }).changes, []);
});
for (const keyword of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']) {
  test(`${keyword} tightening and relaxation`, () => {
    check({ [keyword]: 1 }, { [keyword]: 2 }, 'breaking', 'constraint');
    check({ [keyword]: 2 }, { [keyword]: 1 }, 'compatible', 'constraint');
    check({}, { [keyword]: 1 }, 'breaking', 'constraint');
    check({ [keyword]: 1 }, {}, 'compatible', 'constraint');
  });
}
for (const keyword of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']) {
  test(`${keyword} tightening and relaxation`, () => {
    check({ [keyword]: 2 }, { [keyword]: 1 }, 'breaking', 'constraint');
    check({ [keyword]: 1 }, { [keyword]: 2 }, 'compatible', 'constraint');
    check({}, { [keyword]: 2 }, 'breaking', 'constraint');
    check({ [keyword]: 2 }, {}, 'compatible', 'constraint');
  });
}
test('uniqueItems tightening and relaxation', () => {
  check({}, { uniqueItems: true }, 'breaking');
  check({ uniqueItems: true }, { uniqueItems: false }, 'compatible');
  assert.deepEqual(compare({}, { uniqueItems: false }).changes, []);
});
test('multipleOf introduction, removal, divisibility, and unrelated changes', () => {
  check({}, { multipleOf: 2 }, 'breaking');
  check({ multipleOf: 2 }, {}, 'compatible');
  check({ multipleOf: 2 }, { multipleOf: 4 }, 'breaking');
  check({ multipleOf: 4 }, { multipleOf: 2 }, 'compatible');
  check({ multipleOf: 2 }, { multipleOf: 3 }, 'review');
});
test('pattern introduction breaking, removal compatible, replacement review', () => {
  check({}, { pattern: '^a' }, 'breaking');
  check({ pattern: '^a' }, {}, 'compatible');
  check({ pattern: '^a' }, { pattern: '^b' }, 'review');
});
test('format changes always review, including custom formats', () => {
  check({}, { format: 'email' }, 'review');
  check({ format: 'email' }, {}, 'review');
  check({ format: 'custom' }, { format: 'email' }, 'review');
});
test('additionalProperties closing and opening', () => {
  check({}, { additionalProperties: false }, 'breaking', 'additional-properties');
  check({ additionalProperties: false }, {}, 'compatible', 'additional-properties');
});
test('additionalProperties default true and empty schemas are equivalent', () => {
  assert.deepEqual(compare({}, { additionalProperties: true }).changes, []);
  assert.deepEqual(compare({ additionalProperties: true }, { additionalProperties: {} }).changes, []);
});
test('schema-valued additionalProperties introduction and removal', () => {
  check({}, { additionalProperties: { type: 'string' } }, 'breaking');
  check({ additionalProperties: { type: 'string' } }, {}, 'compatible');
  check({ additionalProperties: false }, { additionalProperties: { type: 'string' } }, 'compatible');
  check({ additionalProperties: { type: 'string' } }, { additionalProperties: false }, 'breaking');
});
test('schema-valued additionalProperties recursively compared', () => {
  const result = check({ additionalProperties: { type: 'number' } }, { additionalProperties: { type: 'integer' } }, 'breaking', 'type');
  assert.equal(result.changes[0].path, '/additionalProperties/type');
});
test('boolean schemas restrictions and widening', () => {
  check(true, false, 'breaking', 'boolean-schema');
  check(false, true, 'compatible', 'boolean-schema');
  check(true, { type: 'string' }, 'breaking', 'boolean-schema');
  check({ type: 'string' }, true, 'compatible', 'boolean-schema');
  check({ type: 'string' }, false, 'breaking', 'boolean-schema');
  check(false, { type: 'string' }, 'compatible', 'boolean-schema');
  assert.deepEqual(compare(true, {}).changes, []);
  assert.deepEqual(compare({}, true).changes, []);
});
for (const [keyword, before, after] of [
  ['anyOf', { anyOf: [{ type: 'string' }] }, { anyOf: [{ type: 'integer' }] }],
  ['allOf', {}, { allOf: [{ minLength: 2 }] }],
  ['oneOf', {}, { oneOf: [{ type: 'string' }, { type: 'number' }] }],
  ['not', {}, { not: { type: 'null' } }],
  ['if/then', { if: { type: 'string' }, then: { minLength: 2 } }, { if: { type: 'string' }, then: { minLength: 3 } }],
  ['dependentRequired', {}, { dependentRequired: { a: ['b'] } }],
  ['patternProperties', {}, { patternProperties: { '^a': { type: 'string' } } }],
  ['items', { items: { type: 'string' } }, { items: { type: 'integer' } }],
  ['prefixItems', {}, { prefixItems: [{ type: 'string' }] }],
  ['const', { const: 1 }, { const: 2 }],
  ['$defs', { $defs: { amount: { minimum: 0 } } }, { $defs: { amount: { minimum: 1 } } }],
  ['$ref', { $defs: { a: { type: 'string' }, b: { type: 'integer' } }, $ref: '#/$defs/a' }, { $defs: { a: { type: 'string' }, b: { type: 'integer' } }, $ref: '#/$defs/b' }],
]) test(`advanced keyword ${keyword} is review only`, () => {
  const result = check(before, after, 'review', 'advanced-keyword');
  assert.equal(result.breaking, 0);
  assert.equal(result.compatible, 0);
});
test('boolean transitions involving advanced constraints remain review', () => {
  check(true, { anyOf: [{ type: 'string' }] }, 'review', 'boolean-schema');
  check({ not: { type: 'string' } }, false, 'review', 'boolean-schema');
});
test('boolean true and annotation-only schemas are equivalent', () => {
  assert.deepEqual(compare(true, { title: 'Sample', default: 1 }).changes, []);
  assert.deepEqual(compare({ description: 'Sample' }, true).changes, []);
  assert.deepEqual(compare({ additionalProperties: true }, { additionalProperties: { description: 'Sample' } }).changes, []);
});
test('comparison nesting guard fails clearly instead of silently truncating', () => {
  let before = { type: 'number' };
  let after = { type: 'integer' };
  for (let depth = 0; depth < 82; depth++) {
    before = object({ nested: before });
    after = object({ nested: after });
  }
  assert.throws(() => compare(before, after), /nesting depth/);
});
test('invalid compare input schemas throw Error', () => {
  assert.throws(() => compare({ type: 'bogus' }, {}), Error);
  assert.throws(() => compare({}, { type: 'bogus' }), Error);
  assert.throws(() => compare({}, { $ref: 'https://example.invalid/unavailable' }), Error);
});
test('comparison does not mutate input', () => {
  const before = structuredClone(baselineSchema);
  const after = structuredClone(candidateSchema);
  compare(before, after);
  assert.deepEqual(before, baselineSchema);
  assert.deepEqual(after, candidateSchema);
});
test('compiled browser ESM bundle exports actual engine and sample data', async () => {
  const bundle = await import('../public/assets/engine.js');
  assert.deepEqual(bundle.baselineSchema, baselineSchema);
  assert.deepEqual(bundle.candidateSchema, candidateSchema);
  assert.deepEqual(bundle.samplePayload, samplePayload);
  assert.equal(bundle.validate(baselineSchema, samplePayload).valid, true);
  assert.equal(bundle.compare(baselineSchema, candidateSchema).breaking, 4);
});
test('browser executes bundled validation offline with no network requests', async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  try {
    const page = await browser.newPage();
    const requests = [];
    const errors = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    const source = await readFile(new URL('../public/assets/engine.js', import.meta.url), 'utf8');
    const result = await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        const engine = await import(url);
        const payload = structuredClone(engine.samplePayload);
        const copy = JSON.stringify(payload);
        return {
          baseline: engine.validate(engine.baselineSchema, payload),
          candidate: engine.validate(engine.candidateSchema, payload),
          diff: engine.compare(engine.baselineSchema, engine.candidateSchema),
          format: engine.validate({ type: 'string', format: 'email' }, 'not-email'),
          remote: engine.validate({ $ref: 'https://example.invalid/no-network' }, {}),
          draft07: engine.validate({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'integer' }, 1),
          unmutated: copy === JSON.stringify(payload),
        };
      } finally { URL.revokeObjectURL(url); }
    }, source);
    assert.equal(result.baseline.valid, true);
    assert.equal(result.candidate.valid, false);
    assert.equal(result.candidate.errors.length, 4);
    assert.equal(result.diff.breaking, 4);
    assert.equal(result.format.valid, false);
    assert.match(result.remote.error, /resolve reference/);
    assert.equal(result.draft07.valid, true);
    assert.equal(result.unmutated, true);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.filter(url => /^https?:/.test(url)), []);
  } finally { await browser.close(); }
});

test('CLI exits 1 on breaking changes, 0 when compatible, 2 on bad input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schemalabs-cli-'));
  try {
    const file = async (name, value) => { const path = join(dir, name); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
    const base = await file('base.json', baselineSchema), next = await file('next.json', candidateSchema), bad = await file('bad.json', '{');
    const cli = (...args) => spawnSync(process.execPath, [new URL('../bin/schemalabs.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), ...args], { encoding: 'utf8' });

    const breaking = cli('--baseline', base, '--candidate', next);
    assert.equal(breaking.status, 1);
    assert.match(breaking.stdout, /BREAKING\s+\/required\/currency/);
    assert.match(breaking.stdout, /4 breaking, 0 review, 0 compatible/);

    const json = cli('--baseline', base, '--candidate', next, '--json');
    assert.equal(json.status, 1);
    assert.deepEqual(JSON.parse(json.stdout), compare(baselineSchema, candidateSchema));

    const same = cli('--baseline', base, '--candidate', base);
    assert.equal(same.status, 0);
    assert.match(same.stdout, /0 breaking/);

    assert.equal(cli('--baseline', base).status, 2);
    assert.equal(cli('--baseline', base, '--candidate', bad).status, 2);
    assert.match(cli('--baseline', base, '--candidate', join(dir, 'missing.json')).stderr, /cannot read candidate schema/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
