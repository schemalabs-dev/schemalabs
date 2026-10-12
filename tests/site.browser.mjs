import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const base = process.env.SCHEMALABS_BASE || 'http://127.0.0.1:8768';
const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [];
const check = (name, detail = true) => { checks.push({ name, detail }); console.log('PASS', name, JSON.stringify(detail)); };
const errors = [], failed = [];
const paths = ['/', '/playground.html', '/docs.html', '/pricing.html', '/changelog.html', '/about.html', '/privacy.html', '/terms.html', '/404.html'];
const githubUrl = 'https://github.com/schemalabs-dev/schemalabs';
const navHrefs = ['/playground.html', '/docs.html', '/pricing.html', '/changelog.html', '/about.html', githubUrl];
const assertSharedNav = async (page, path) => {
  const nav = await page.locator('#site-nav > a').evaluateAll(links => links.map(a => ({ href: a.getAttribute('href'), current: a.getAttribute('aria-current'), label: a.getAttribute('aria-label') })));
  assert.deepEqual(nav.map(a => a.href), navHrefs, path + ' header nav links');
  assert.equal(nav.filter(a => a.current === 'page').length, ['/', '/404.html', '/privacy.html', '/terms.html'].includes(path) ? 0 : 1, path + ' marks one current page');
  assert.equal(nav.at(-1).label, 'Schema Labs on GitHub');
  const footerHrefs = await page.locator('.site-footer a').evaluateAll(links => links.map(a => a.getAttribute('href')));
  for (const href of ['/pricing.html', '/changelog.html', githubUrl]) assert.ok(footerHrefs.includes(href), path + ' footer links ' + href);
};
const assertCspAllowsOnlyAnthropic = async () => {
  const csp = (await readFile(new URL('../public/_headers', import.meta.url), 'utf8')).match(/Content-Security-Policy: (.*)/)[1];
  assert.match(csp, /connect-src https:\/\/api\.anthropic\.com(;|$)/);
  assert.doesNotMatch(csp, /connect-src[^;]*(\*|'self'|'none')/);
};
// Reject unrelated project identities, but allow this company's published registration details.
const unrelatedIdentity = /diffhaven|paytool|pages\.dev/i;
const registryUrl = 'https://find-and-update.company-information.service.gov.uk/company/15348827';
const assertCompanyFooter = async page => {
  const footer = page.locator('.site-footer .footer-company');
  assert.equal(await footer.count(), 1, 'One company disclosure per footer');
  assert.equal(await footer.isVisible(), true, 'Company disclosure is visible');
  assert.match(await footer.innerText(), /Website operated by Schema Labs Ltd\./);
  assert.match(await footer.innerText(), /Company No\. 15348827.*Registered in England and Wales/s);
  assert.match(await footer.innerText(), /Registered office: 20 Wenlock Road, London, England, N1 7GU/);
  assert.equal(await footer.locator('a').getAttribute('href'), '/about.html#company-information');
  assert.equal(await page.locator('.footer-bottom > span').first().innerText(), '© 2026 Schema Labs Ltd');
  assert.doesNotMatch(await page.locator('.footer-bottom').innerText(), /Developer preview/i);
};
assert.equal(unrelatedIdentity.test('Schema Labs Ltd 15348827 20 Wenlock Road'), false);
for (const foreign of ['DiffHaven', 'PayTool', 'schemalabs.pages.dev']) {
  assert.equal(unrelatedIdentity.test(foreign), true, 'Foreign identity matcher still rejects ' + foreign);
}
await assertCspAllowsOnlyAnthropic();
check('CSP permits only api.anthropic.com for connections');
check('Identity matcher allows company registration and rejects unrelated projects');
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  page.on('requestfailed', r => failed.push({ url: r.url(), error: r.failure()?.errorText }));
  const links = new Set();
  for (const path of paths) {
    const response = await page.goto(base + path, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    await page.evaluate(() => document.fonts.ready);
    const state = await page.evaluate(() => ({
      h1: document.querySelectorAll('h1').length,
      canonical: document.querySelector('link[rel=canonical]')?.href,
      overflow: document.documentElement.scrollWidth > innerWidth,
      brand: document.querySelector('.brand')?.innerText,
      images: [...document.images].filter(x => !x.complete || !x.naturalWidth).map(x => x.src),
      hrefs: [...document.querySelectorAll('a[href]')].map(x => x.getAttribute('href')),
      bodyText: document.body.innerText,
      assets: [...document.querySelectorAll('link[href], script[src]')].map(el => el.getAttribute('href') || el.getAttribute('src')).filter(url => url.startsWith('/assets/')),
    }));
    assert.equal(state.h1, 1, path + ' one H1');
    assert.equal(state.overflow, false, path + ' desktop overflow');
    assert.equal(unrelatedIdentity.test(state.bodyText), false, path + ' identity consistency');
    assert.equal(state.brand?.trim(), 'Schema Labs', path + ' brand consistency');
    assert.equal(state.images.length, 0);
    assert.ok(state.canonical?.startsWith('https://schemalabs.co.uk/'));
    for (const h of state.hrefs) { if (h.startsWith('/')) links.add(h); }
    check('Desktop page ' + path, { status: response.status(), title: await page.title(), canonical: state.canonical });
    await assertCompanyFooter(page);
    check('Company footer ' + path);
    await assertSharedNav(page, path);
    check('Header nav, GitHub icon and footer links ' + path);
    assert.ok(state.assets.length > 0, path + ' publishes assets');
    for (const ref of state.assets) {
      const asset = new URL(ref, base);
      const expected = createHash('sha256').update(await readFile(new URL('../public' + asset.pathname, import.meta.url))).digest('hex').slice(0, 12);
      assert.equal(asset.searchParams.get('v'), expected, path + ' cache version ' + asset.pathname);
    }
    check('Published asset URLs carry exact content versions ' + path, { assets: state.assets.length });
  }
  if (base.startsWith('https:')) {
    const response = await page.goto(base + '/', { waitUntil: 'networkidle' });
    const headers = response.headers();
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options'], 'DENY');
    for (const directive of ["style-src 'self'", "worker-src 'self'", 'connect-src https://api.anthropic.com']) {
      assert.ok(headers['content-security-policy']?.includes(directive), 'Production CSP includes ' + directive);
    }
    assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
    check('Production security headers and CSP are present');
    for (const suffix of ['/', '/playground.html?mode=compare']) {
      const response = await context.request.get('https://www.schemalabs.co.uk' + suffix, { maxRedirects: 0 });
      assert.equal(response.status(), 301);
      assert.equal(response.headers().location, 'https://schemalabs.co.uk' + suffix);
    }
    check('WWW redirects to canonical hostname with path and query preserved');
  }
  await page.goto(base + '/about.html');
  const companySection = page.locator('#company-information');
  assert.equal(await companySection.isVisible(), true);
  assert.equal(await companySection.locator('h2').innerText(), 'Company information');
  assert.equal(await page.locator('.article-nav a[href="#company-information"]').count(), 1);
  const companyFacts = await companySection.locator('.detail-list').evaluate(dl =>
    Object.fromEntries([...dl.querySelectorAll('dt')].map(dt => [dt.innerText.trim(), dt.nextElementSibling.innerText.trim()]))
  );
  assert.deepEqual(companyFacts, {
    'Company name': 'SCHEMA LABS LTD',
    'Company number': '15348827',
    'Company status': 'Active',
    'Company type': 'Private limited company',
    'Incorporated on': '13 December 2023',
    'Jurisdiction': 'England and Wales',
    'Registered office': '20 Wenlock Road, London, England, N1 7GU',
    'Nature of business (SIC)': '62012 — Business and domestic software development',
  });
  assert.equal(await companySection.locator('a[data-company-record]').getAttribute('href'), registryUrl);
  assert.equal(await companySection.locator('a[data-company-record]').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('.site-footer a[href="/about.html#company-information"]').count(), 1);
  check('About company information matches registry fields and exposes the public source');
  await companySection.screenshot({ path: new URL('desktop-company-information.png', output).pathname.replace(/^\/(\w:)/, '$1') });
  await page.locator('.site-footer').screenshot({ path: new URL('desktop-company-footer.png', output).pathname.replace(/^\/(\w:)/, '$1') });
  for (const path of ['/about.html', '/privacy.html', '/terms.html']) {
    await page.goto(base + path);
    assert.match(await page.locator('main [data-company-operator]').innerText(), /Schema Labs Ltd.*operates.*schemalabs\.co\.uk/s);
    assert.doesNotMatch(await page.locator('main').innerText(), /maintainer|Thanh Hưng Nguyễn|independent developer project/i);
    check('Corporate operator is explicit in main content ' + path);
  }
  await page.goto(base + '/pricing.html');
  const firstLines = texts => texts.map(x => x.split('\n')[0].trim());
  const tierNames = await page.locator('.tier h2').allInnerTexts();
  assert.deepEqual(['Free Community', 'Pro / Team', 'Enterprise'].map((name, i) => tierNames[i]?.startsWith(name)), [true, true, true]);
  assert.deepEqual(firstLines(await page.locator('.tier-price').allInnerTexts()), ['$0', '$29', 'Custom']);
  assert.match(await page.locator('.tier').nth(0).innerText(), /512 KB[\s\S]*Draft-07 and 2020-12[\s\S]*never leave your tab/);
  assert.match(await page.locator('.tier').nth(1).innerText(), /Claude AI Migration Explainer[\s\S]*release notes[\s\S]*GitHub Action[\s\S]*schema registry/);
  assert.match(await page.locator('.tier').nth(2).innerText(), /SSO \/ SAML[\s\S]*on-premise or VPC[\s\S]*SLA[\s\S]*custom schema dialects/i);
  assert.equal(await page.locator('table.compare thead th').count(), 4);
  assert.ok(await page.locator('table.compare tbody tr:not(.group)').count() >= 10);
  assert.equal(await page.locator('table.compare tbody th[scope=row]', { hasText: 'SSO / SAML' }).count(), 1);
  check('Pricing page shows three tiers and the feature comparison grid');
  assert.equal(await page.locator('.faq-item').count(), 3);
  assert.equal(await page.locator('.faq-item[open]').count(), 0);
  await page.locator('.faq-item summary', { hasText: 'proprietary schemas uploaded' }).click();
  assert.match(await page.locator('.faq-item[open]').innerText(), /No\. Validation and comparison run in your browser[\s\S]*never sent anywhere[\s\S]*breaking findings/);
  await page.locator('.faq-item summary', { hasText: 'train AI models' }).click();
  assert.match(await page.locator('.faq-item[open]').last().innerText(), /not used to train its models by default/);
  await page.locator('.faq-item summary', { hasText: 'deterministic rules with Claude' }).click();
  assert.match(await page.locator('.faq-item[open]').last().innerText(), /same two schemas always produce the same findings/);
  assert.doesNotMatch(await page.locator('.faq').innerText(), /false positive/i);
  check('Pricing FAQ answers AI privacy questions without overclaiming');
  await page.screenshot({ path: new URL('desktop-pricing.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await page.goto(base + '/changelog.html');
  assert.deepEqual(await page.locator('.release h2').allInnerTexts(), ['v1.2.0', 'v1.1.0', 'v1.0.0']);
  assert.deepEqual(await page.locator('.release time').evaluateAll(t => t.map(x => x.getAttribute('datetime'))), ['2026-10', '2026-08', '2026-06']);
  assert.match(await page.locator('[id="v1.2.0"]').innerText(), /Claude AI Migration Explainer[\s\S]*Web Worker[\s\S]*Geist Variable/);
  assert.match(await page.locator('[id="v1.1.0"]').innerText(), /2020-12[\s\S]*diff highlighter/);
  check('Changelog lists v1.2.0, v1.1.0 and v1.0.0 newest first');
  await page.screenshot({ path: new URL('desktop-changelog.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await page.goto(base + '/docs.html#ci');
  assert.equal(await page.locator('.article-nav a[href="#ci"]').count(), 1);
  assert.equal(await page.locator('#ci h2').innerText(), 'Automating contract checks in CI');
  assert.equal(await page.locator('#ci figcaption').innerText(), '.github/workflows/schema-check.yml');
  const workflow = await page.locator('#ci pre code').innerText();
  assert.match(workflow, /on:\s+pull_request:[\s\S]*actions\/checkout@v4[\s\S]*fetch-depth: 0[\s\S]*actions\/setup-node@v4[\s\S]*src\/engine\.js[\s\S]*process\.exit\(1\)/);
  assert.match(workflow, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  check('Docs show a CI workflow template and keep the page within the viewport');
  await page.screenshot({ path: new URL('desktop-docs-ci.png', output).pathname.replace(/^\/(\w:)/, '$1') });
  for (const href of links) {
    const url = new URL(href, base);
    const response = await context.request.get(url.href);
    assert.equal(response.status(), 200, 'Internal link: ' + href);
    if (url.hash) {
      await page.goto(url.href);
      assert.equal(await page.locator('[id="' + decodeURIComponent(url.hash.slice(1)) + '"]').count(), 1);
    }
  }
  check('Every distinct internal link resolves', { count: links.size });
  await page.goto(base + '/');
  await page.locator('#demo-run').click();
  await page.locator('#demo-result').filter({ hasText: '4 breaking changes found.' }).waitFor();
  assert.equal(await page.locator('#demo-run').isEnabled(), true);
  check('Home example calculates actual tightened-schema findings');
  await page.locator('#demo-unchanged').click();
  await page.locator('#demo-run').click();
  await page.locator('#demo-result').filter({ hasText: 'No structural changes detected' }).waitFor();
  check('Home unchanged-schema example is computed');
  await page.locator('#demo-tightened').click();
  await page.locator('#demo-run').click();
  await page.locator('#demo-result').filter({ hasText: '4 breaking changes found' }).waitFor();
  await page.screenshot({ path: new URL('desktop-home.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await page.goto(base + '/playground.html');
  assert.equal(await page.locator('.pg-head .kicker').innerText(), 'Developer preview');
  check('Developer preview is disclosed in Playground, not the copyright line');
  await page.waitForFunction(() => document.querySelector('#left-editor').value.length > 0);
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'Payload satisfies' }).waitFor();
  check('Playground baseline sample validates');
  await page.locator('#right-editor').fill('{"id":"demo","total":"42.5"}');
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'needs attention' }).waitFor();
  assert.match(await page.locator('#results').innerText(), /\/total/);
  assert.equal(await page.locator('.change-row').count(), 1);
  check('Invalid payload returns exact field path and finding');
  await page.locator('#tab-compare').click();
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: '4 changes' }).waitFor();
  assert.equal(await page.locator('.change-row').count(), 4);
  assert.match(await page.locator('.results-meta').innerText(), /4 breaking/);
  check('Schema comparison reports four breaking findings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-report').click()]);
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(report.result.breaking, 4);
  assert.equal(report.mode, 'compare');
  assert.equal(Object.hasOwn(report, 'left'), false);
  assert.equal(Object.hasOwn(report, 'right'), false);
  check('Downloaded report contains computed result and no source documents');
  await page.locator('#right-editor').fill(await page.locator('#left-editor').inputValue());
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'No structural changes' }).waitFor();
  check('Identical schemas have no changes');
  await page.locator('#right-editor').fill('{');
  await page.locator('#run-check').click();
  await page.locator('.results-error').waitFor();
  assert.match(await page.locator('#results').innerText(), /not valid JSON/);
  assert.equal(await page.locator('#download-report').isVisible(), false);
  check('Malformed JSON gives clear error and no stale download');
  await page.locator('#clear-inputs').click();
  assert.equal(await page.locator('#left-editor').inputValue(), '');
  assert.equal(await page.locator('#right-editor').inputValue(), '');
  await page.locator('#run-check').click();
  assert.match(await page.locator('#results').innerText(), /empty/);
  check('Clear and empty-input checks work');
  await page.locator('#tab-validate').click();
  await page.locator('#left-editor').fill('{"$ref":"https://example.invalid/schema.json"}');
  await page.locator('#right-editor').fill('{}');
  await page.locator('#run-check').click();
  await page.locator('.results-error').waitFor();
  assert.match(await page.locator('#results').innerText(), /resolve reference/);
  check('Remote reference gives local resolution error');
  await page.locator('#left-editor').fill('{"$schema":"http://json-schema.org/draft-07/schema#","type":"integer"}');
  await page.locator('#right-editor').fill('2');
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'satisfies' }).waitFor();
  check('Draft-07 works through UI');
  await page.locator('#load-example').click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.locator('#upload-right').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'payload.json', mimeType: 'application/json', buffer: Buffer.from('{"id":"local-file","total":32.5}') });
  await page.waitForFunction(() => document.querySelector('#right-editor').value.includes('local-file'));
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'satisfies' }).waitFor();
  check('Local file input validates without uploading');
  const oversize = '"' + 'é'.repeat(270000) + '"';
  await page.locator('#right-editor').fill(oversize);
  await page.locator('#run-check').click();
  await page.locator('.results-error').waitFor();
  assert.match(await page.locator('#results').innerText(), /512 KB/);
  check('UTF-8 size limit rejects oversized input');
  await page.goto(base + '/playground.html?mode=compare');
  assert.equal(await page.locator('#tab-compare').getAttribute('aria-selected'), 'true');
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: '4 changes' }).waitFor();
  await page.screenshot({ path: new URL('desktop-playground.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  check('Direct comparison route works');
  await page.goto(base + '/playground.html?mode=compare');
  assert.deepEqual(await page.locator('#sample-select option').allInnerTexts(), ['Order Checkout (Default)', 'Stripe Webhook Event (Draft-07)']);
  await page.locator('#sample-select').selectOption('webhook');
  await page.locator('.results-title').filter({ hasText: '5 changes' }).waitFor();
  assert.match(await page.locator('.results-meta').innerText(), /5 breaking/);
  assert.match(await page.locator('#left-editor').inputValue(), /draft-07\/schema#[\s\S]*Sample Webhook Event/);
  assert.match(await page.locator('#results').innerText(), /\/required\/livemode[\s\S]*\/properties\/type\/enum/);
  await page.locator('#sample-select').selectOption('order');
  await page.locator('.results-title').filter({ hasText: '4 changes' }).waitFor();
  assert.match(await page.locator('#left-editor').inputValue(), /Sample Purchase/);
  await page.locator('#sample-select').selectOption('webhook');
  await page.locator('.results-title').filter({ hasText: '5 changes' }).waitFor();
  await page.locator('#tab-validate').click();
  assert.equal(await page.locator('#sample-select').inputValue(), 'webhook');
  assert.match(await page.locator('#left-editor').inputValue(), /Sample Webhook Event/);
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'Payload satisfies' }).waitFor();
  await page.locator('#sample-select').selectOption('order');
  await page.locator('.results-title').filter({ hasText: 'Payload satisfies' }).waitFor();
  assert.match(await page.locator('#right-editor').inputValue(), /sample-purchase-001/);
  check('Sample picker loads Order and Webhook samples and runs the check in both modes');
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('#sample-select').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  check('Sample picker fits a 320px viewport');
  const ai = await context.newPage();
  ai.on('pageerror', e => errors.push(e.message));
  ai.on('console', e => { if (e.type() === 'error' && !e.location().url.startsWith('https://api.anthropic.com/')) errors.push(e.text()); }); // mocked 401/429 are logged by Chrome
  const anthropic = { mode: '401', calls: [] };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' };
  await ai.route('https://api.anthropic.com/**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    anthropic.calls.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
    if (anthropic.mode === '401') return route.fulfill({ status: 401, headers: cors, json: { error: { message: 'invalid x-api-key' } } });
    if (anthropic.mode === '429') return route.fulfill({ status: 429, headers: { ...cors, 'access-control-expose-headers': 'retry-after', 'retry-after': '12' }, json: { error: { message: 'rate_limited' } } });
    await new Promise(r => setTimeout(r, 400));
    return route.fulfill({ status: 200, headers: cors, json: { content: [{ type: 'text', text: 'Here you go:\n' + JSON.stringify({ summary: 'Four changes reject legacy payloads.', findings: [{ path: '/required/currency', why: 'Old producers omit currency.' }], adapter_schema: { type: 'object', properties: { currency: { default: 'USD' } } }, regression_test: "test('legacy payload', () => {});" }) }] } });
  });
  await ai.goto(base + '/playground.html');
  await ai.locator('#run-check').click();
  await ai.locator('.results-title').filter({ hasText: 'satisfies' }).waitFor();
  assert.equal(await ai.locator('.explain-bar').count(), 0);
  await ai.locator('#tab-compare').click();
  await ai.locator('#run-check').click();
  await ai.locator('.results-title').filter({ hasText: '4 changes' }).waitFor();
  const explain = ai.getByRole('button', { name: 'Explain breaking changes with Claude (Beta)' });
  await explain.click();
  assert.equal(await ai.locator('#ai-settings').isVisible(), true);
  await ai.locator('#ai-key').fill('not-a-key');
  await ai.getByRole('button', { name: 'Save & explain' }).click();
  assert.match(await ai.locator('#ai-settings .field-error').innerText(), /sk-ant-/);
  check('Explainer asks for an sk-ant key and rejects malformed input');
  await ai.getByRole('button', { name: 'Test with mock explainer' }).click();
  await ai.locator('.brief h3').filter({ hasText: 'AI Migration Brief' }).waitFor();
  assert.match(await ai.locator('.brief-source').innerText(), /Mock explainer/);
  assert.equal(await ai.locator('.brief-code').count(), 2);
  assert.match(await ai.locator('.brief').innerText(), /\/required\/currency[\s\S]*Suggested adapter schema[\s\S]*Regression test/);
  assert.deepEqual(anthropic.calls, []);
  assert.equal(await ai.evaluate(() => localStorage.length), 0);
  check('Mock explainer renders a brief with adapter and regression test and makes no network call');
  await ai.setViewportSize({ width: 320, height: 800 });
  assert.equal(await ai.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await ai.screenshot({ path: new URL('mobile-explainer.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await ai.getByRole('button', { name: 'API settings' }).click();
  assert.equal(await ai.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await ai.locator('#ai-settings').evaluate(d => d.getBoundingClientRect().right <= innerWidth), true);
  await ai.getByRole('button', { name: 'Cancel' }).click();
  await ai.setViewportSize({ width: 1440, height: 1000 });
  check('Explainer brief and settings dialog fit a 320px viewport');
  await ai.getByRole('button', { name: 'API settings' }).click();
  await ai.locator('#ai-key').fill('sk-ant-test-0000000000');
  await ai.getByRole('button', { name: 'Save & explain' }).click();
  await ai.locator('.results-error[role=alert]').filter({ hasText: '401' }).waitFor();
  assert.equal(anthropic.calls.length, 1);
  const call = anthropic.calls[0];
  assert.equal(call.headers['x-api-key'], 'sk-ant-test-0000000000');
  assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(call.body.model, 'claude-sonnet-5-5');
  const sent = JSON.parse(call.body.messages[0].content).breaking_findings;
  assert.equal(sent.length, 4);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['kind', 'message', 'path']);
  assert.doesNotMatch(JSON.stringify(call.body), /Sample Purchase|refunded|\$schema/);
  check('Claude request carries only the four breaking findings, never the schemas');
  anthropic.mode = '429';
  await explain.click();
  await ai.locator('.results-error[role=alert]').filter({ hasText: 'Rate limit reached (429). Retry in about 12 seconds.' }).waitFor();
  check('Explainer reports invalid key and rate limit clearly');
  anthropic.mode = '200';
  await explain.click();
  await ai.locator('.brief.is-loading').waitFor();
  await ai.locator('.brief h3').filter({ hasText: 'AI Migration Brief' }).waitFor();
  assert.match(await ai.locator('.brief-source').innerText(), /Claude · claude-sonnet-5-5/);
  assert.match(await ai.locator('.brief').innerText(), /Old producers omit currency\./);
  assert.equal(await ai.evaluate(() => localStorage.length), 0);
  check('Claude response is parsed into a brief after a loading state; key is not persisted by default');
  await ai.getByRole('button', { name: 'API settings' }).click();
  await ai.locator('#ai-settings input[name=remember]').check();
  await ai.getByRole('button', { name: 'Save & explain' }).click();
  await ai.locator('.brief h3').filter({ hasText: 'AI Migration Brief' }).waitFor();
  assert.equal(await ai.evaluate(() => localStorage.getItem('schemalabs.anthropic-key')), 'sk-ant-test-0000000000');
  await ai.reload();
  await ai.locator('#tab-compare').click();
  await ai.locator('#run-check').click();
  await ai.locator('.results-title').filter({ hasText: '4 changes' }).waitFor();
  const callsBefore = anthropic.calls.length;
  await ai.getByRole('button', { name: 'Explain breaking changes with Claude (Beta)' }).click();
  await ai.locator('.brief h3').filter({ hasText: 'AI Migration Brief' }).waitFor();
  assert.equal(anthropic.calls.length, callsBefore + 1);
  assert.equal(await ai.locator('#ai-settings').isVisible(), false);
  await ai.getByRole('button', { name: 'API settings' }).click();
  await ai.getByRole('button', { name: 'Remove key' }).click();
  assert.equal(await ai.evaluate(() => localStorage.length), 0);
  check('Remembered key is reused after reload and can be removed');
  await ai.close();
  const apiRequests = [];
  page.on('request', req => {
    if (['fetch', 'xhr'].includes(req.resourceType())) apiRequests.push(req.url());
    assert.equal(new URL(req.url()).origin, new URL(base).origin, 'Unexpected third-party request: ' + req.url());
  });
  await page.goto(base + '/playground.html');
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'satisfies' }).waitFor();
  await page.locator('#tab-compare').click();
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: '4 changes' }).waitFor();
  assert.deepEqual(apiRequests, []);
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
  assert.deepEqual(storage, { local: 0, session: 0, cookies: '' });
  check('Checks make no document API calls and persist no browser storage');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#right-editor').value.includes('currency'));
  assert.equal(await page.locator('#download-report').isVisible(), false);
  check('Reload clears results');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of paths) {
      await page.goto(base + path);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, path + ' overflow at ' + width);
      await assertCompanyFooter(page);
      if (path === '/about.html') assert.equal(await page.locator('#company-information').isVisible(), true);
    }
    check('All pages fit viewport', { width, pages: paths.length });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/about.html#company-information');
  await page.locator('#company-information').screenshot({ path: new URL('mobile-company-information.png', output).pathname.replace(/^\/(\w:)/, '$1') });
  await page.locator('.site-footer').screenshot({ path: new URL('mobile-company-footer.png', output).pathname.replace(/^\/(\w:)/, '$1') });
  await page.goto(base + '/');
  assert.equal(await page.locator('#site-nav').isVisible(), false);
  await page.locator('.menu-toggle').click();
  assert.equal(await page.locator('#site-nav').isVisible(), true);
  assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#site-nav').isVisible(), false);
  check('Mobile menu opens and closes via Escape');
  await page.reload();
  assert.equal(await page.locator('.skip').evaluate(e => e.getBoundingClientRect().width), 1);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.skip').evaluate(e => e === document.activeElement), true);
  assert.ok(await page.locator('.skip').evaluate(e => e.getBoundingClientRect().width) > 40);
  await page.keyboard.press('Tab');
  check('Skip link is hidden normally and keyboard accessible');
  await page.locator('#demo-run').click();
  await page.locator('#demo-result').filter({ hasText: '4 breaking' }).waitFor();
  await page.screenshot({ path: new URL('mobile-home.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await page.goto(base + '/playground.html');
  await page.locator('#run-check').click();
  await page.locator('.results-title').filter({ hasText: 'satisfies' }).waitFor();
  await page.screenshot({ path: new URL('mobile-playground.png', output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  check('Mobile playground executes same real validator');
  await page.locator('#tab-validate').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-compare').getAttribute('aria-selected'), 'true');
  check('Tool tab keyboard navigation');
  assert.deepEqual(errors, [], 'Browser errors');
  assert.deepEqual(failed, [], 'Failed requests');
  check('No browser JavaScript, console or request failures');
  await writeFile(new URL('browser-checks.json', output), JSON.stringify({ base, total: checks.length, checks, errors, failed }, null, 2));
  console.log('RESULT', JSON.stringify({ base, checks: checks.length, errors: errors.length, failedRequests: failed.length }));
} finally { await browser.close(); }
