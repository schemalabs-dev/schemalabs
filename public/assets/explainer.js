// Claude AI Migration Explainer (Beta). Sends only breaking findings (path, rule, message) straight from the
// browser to api.anthropic.com; schemas and payloads are never included. Keys live in memory unless the user opts in.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const KEY = 'schemalabs.anthropic-key', MODEL = 'schemalabs.anthropic-model';
const MAX_FINDINGS = 40;
let sessionKey = '';

const store = {
  get(name) { try { return localStorage.getItem(name) || ''; } catch { return ''; } },
  set(name, value) { try { localStorage.setItem(name, value); } catch { /* storage blocked: key stays in memory */ } },
  del(name) { try { localStorage.removeItem(name); } catch { /* nothing to remove */ } },
};
export const savedKey = () => store.get(KEY);
export const currentKey = () => sessionKey || savedKey();
export const currentModel = () => store.get(MODEL) || DEFAULT_MODEL;
export function setKey(key, model, remember) {
  sessionKey = key;
  if (remember) { store.set(KEY, key); store.set(MODEL, model); } else { store.del(KEY); store.del(MODEL); }
}
export function forgetKey() { sessionKey = ''; store.del(KEY); store.del(MODEL); }

export const breakingFindings = changes =>
  changes.filter(c => c.severity === 'breaking').slice(0, MAX_FINDINGS).map(({ path, kind, message }) => ({ path, kind, message }));

const nameOf = path => { const parts = path.split('/').filter(Boolean); const i = parts.lastIndexOf('properties'); return i >= 0 ? parts[i + 1] : parts[parts.length - 1] || 'root'; };
const REASONS = {
  'required-added': 'Existing producers that omit this field are now rejected.',
  type: 'Values of a previously allowed type are now rejected.',
  enum: 'Values that used to be valid enum members are now rejected.',
  constraint: 'A boundary tightened, so inputs near the old limit now fail.',
  'property-removed': 'Clients that still send this property are now rejected.',
  'additional-properties': 'Extra properties that were tolerated are now rejected.',
  'boolean-schema': 'The accepted input set shrank.',
};

/** Deterministic, offline stand-in with the same shape as the Claude response. Nothing leaves the browser. */
export function mockBrief(findings) {
  const props = {};
  for (const f of findings) props[nameOf(f.path)] = f.kind === 'required-added' ? { $comment: `Default ${f.path} for legacy payloads.`, default: null } : { $comment: `Normalise legacy values for ${f.path} before validation.` };
  const cases = findings.map(f => `  test(${JSON.stringify('breaking ' + f.path)}, () => {\n    // TODO: replace with a payload the old contract accepted\n    const legacy = fixtures[${JSON.stringify(f.path)}];\n    assert.equal(oldValidate(legacy), true);\n    assert.equal(newValidate(adapt(legacy)), true);\n  });`).join('\n\n');
  return {
    summary: `${findings.length} breaking ${findings.length === 1 ? 'change rejects' : 'changes reject'} payloads the baseline accepted. Demo output generated locally from rule names only.`,
    findings: findings.map(f => ({ path: f.path, why: REASONS[f.kind] || 'The new schema accepts fewer inputs than the baseline.' })),
    adapter_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', $comment: 'Transitional adapter sketch (demo).', type: 'object', properties: props },
    regression_test: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { oldValidate, newValidate, adapt, fixtures } from './contracts.js';\n\n${cases}\n`,
  };
}

const SYSTEM = 'You are a senior API-contract engineer. You receive ONLY a list of breaking findings from a JSON Schema comparison (JSON Pointer path, rule kind, message); you never see the schemas. Reply with a single JSON object and nothing else: {"summary": string (max 2 sentences, English), "findings": [{"path": string, "why": string (one sentence on who breaks and why)}], "adapter_schema": object (a transitional JSON Schema fragment that tolerates legacy payloads for the affected paths), "regression_test": string (a node:test + Ajv snippet, one test per finding)}. Do not invent fields beyond the given paths; state assumptions in $comment.';

const explainError = async res => {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch { /* non-JSON error body */ }
  if (res.status === 401) return 'Anthropic rejected the API key (401). Check that it starts with sk-ant- and has not been revoked.';
  if (res.status === 403) return `The key is not permitted to call this model (403). ${detail}`.trim();
  if (res.status === 404) return `Model not found (404). Change the model name in API settings. ${detail}`.trim();
  if (res.status === 429) { const wait = res.headers.get('retry-after'); return `Rate limit reached (429). ${wait ? `Retry in about ${wait} seconds.` : 'Wait a moment and try again.'}`; }
  if (res.status === 529 || res.status >= 500) return `Anthropic is overloaded or unavailable (${res.status}). Try again shortly.`;
  return `Anthropic returned ${res.status}. ${detail}`.trim();
};

export async function claudeBrief(findings, key, model, signal) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 2500, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify({ breaking_findings: findings }) }] }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not reach api.anthropic.com. Check your connection or a content blocker, then try again.');
  }
  if (!res.ok) throw new Error(await explainError(res));
  const text = (await res.json()).content?.find(part => part.type === 'text')?.text || '';
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
  catch { throw new Error('Claude replied in an unexpected format. Try again; nothing was changed.'); }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function codeBlock(title, code, language) {
  const figure = el('figure', 'brief-code'), caption = el('figcaption', 'brief-code-head'), copy = el('button', 'upload-button', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy blocked'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
  });
  caption.append(el('span', '', title), copy);
  const pre = el('pre'), inner = el('code', language); inner.textContent = code; pre.tabIndex = 0; pre.append(inner);
  figure.append(caption, pre); return figure;
}
function briefCard(brief, source) {
  const card = el('section', 'brief'), head = el('div', 'brief-head');
  card.setAttribute('aria-label', 'AI Migration Brief');
  head.append(el('h3', '', 'AI Migration Brief'), el('span', 'tag review', 'Beta'), el('span', 'brief-source', source));
  const list = el('ol', 'brief-list');
  for (const item of Array.isArray(brief.findings) ? brief.findings : []) {
    const li = el('li'); li.append(el('code', 'change-path', String(item.path ?? '')), el('span', '', String(item.why ?? ''))); list.append(li);
  }
  card.append(head, el('p', 'brief-summary', String(brief.summary ?? '')), list,
    codeBlock('Suggested adapter schema', JSON.stringify(brief.adapter_schema ?? {}, null, 2), 'language-json'),
    codeBlock('Regression test', String(brief.regression_test ?? ''), 'language-js'),
    el('p', 'brief-note', 'AI-generated from the findings alone, without your schemas. Review before use.'));
  return card;
}
function loadingCard(count, cancel) {
  const card = el('section', 'brief is-loading'), row = el('div', 'brief-head'), stop = el('button', 'button small ghost', 'Cancel');
  stop.type = 'button'; stop.addEventListener('click', cancel);
  card.setAttribute('aria-busy', 'true');
  row.append(el('h3', '', 'AI Migration Brief'), el('span', 'tag review', 'Beta'));
  card.append(row, el('strong', 'brief-wait', `Claude is reading ${count} breaking ${count === 1 ? 'finding' : 'findings'}…`), el('div', 'skeleton-line'), el('div', 'skeleton-line short'), stop);
  return card;
}
function errorCard(message) {
  const box = el('div', 'results-error'); box.setAttribute('role', 'alert');
  box.append(el('strong', '', 'Claude could not explain these changes'), el('span', '', message)); return box;
}

/** Mounts the explain button, API settings dialog and brief area under the compare results. */
export function mountExplainer(host, changes) {
  const findings = breakingFindings(changes);
  if (!findings.length) return;
  const bar = el('div', 'explain-bar'), explain = el('button', 'button small', 'Explain breaking changes with Claude (Beta)');
  const settings = el('button', 'button small ghost', 'API settings'), slot = el('div', 'brief-slot');
  explain.type = settings.type = 'button';
  bar.append(explain, settings, el('span', 'explain-note', `Sends ${findings.length} finding${findings.length === 1 ? '' : 's'} (paths and messages only), never your schemas.`));
  host.append(bar, slot);
  let controller = null;
  const run = async mock => {
    controller?.abort(); controller = new AbortController();
    const mine = controller, key = currentKey(), model = currentModel();
    explain.disabled = true;
    slot.replaceChildren(loadingCard(findings.length, () => mine.abort()));
    try {
      const brief = mock ? mockBrief(findings) : await claudeBrief(findings, key, model, mine.signal);
      if (slot.isConnected) slot.replaceChildren(briefCard(brief, mock ? 'Mock explainer · no network' : `Claude · ${model}`));
    } catch (error) {
      if (slot.isConnected) slot.replaceChildren(error.name === 'AbortError' ? el('p', 'results-note', 'Explanation cancelled.') : errorCard(error.message));
    } finally { explain.disabled = false; }
  };
  const configure = () => openSettings(choice => { if (choice) run(choice === 'mock'); });
  explain.addEventListener('click', () => (currentKey() ? run(false) : configure()));
  settings.addEventListener('click', configure);
  window.addEventListener('pagehide', () => controller?.abort(), { once: true });
}

function openSettings(done) {
  const dialog = document.getElementById('ai-settings'), form = dialog.querySelector('form');
  const key = form.elements.key, model = form.elements.model, remember = form.elements.remember, error = form.querySelector('.field-error');
  key.value = currentKey(); model.value = currentModel(); remember.checked = Boolean(savedKey()); error.textContent = '';
  form.querySelector('[data-forget]').hidden = !currentKey();
  const finish = value => { dialog.close(); done(value); };
  form.onsubmit = event => {
    event.preventDefault();
    const value = key.value.trim();
    if (!/^sk-ant-\S{10,}$/.test(value)) { error.textContent = 'Enter a key that starts with sk-ant-.'; key.focus(); return; }
    setKey(value, model.value.trim() || DEFAULT_MODEL, remember.checked); finish('claude');
  };
  form.querySelector('[data-mock]').onclick = () => finish('mock');
  form.querySelector('[data-forget]').onclick = () => { forgetKey(); finish(null); };
  form.querySelector('[data-cancel]').onclick = () => finish(null);
  dialog.showModal(); key.focus();
}
