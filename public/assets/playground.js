import { samples } from './samples.js';
import { mountExplainer } from './explainer.js';
const $ = id => document.getElementById(id);
const left = $('left-editor'), right = $('right-editor'), results = $('results'), briefHost = $('brief-host');
const run = $('run-check'), download = $('download-report');
let mode = 'validate', sample = 'order', report = null, busy = false, worker = null, requestId = 0, timer = null, pending = null;
const maximum = 512 * 1024;
const enc = new TextEncoder();
const pretty = value => JSON.stringify(value, null, 2);
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function status(text) {
  const toast = $('toast'); toast.textContent = text; toast.classList.add('show');
  clearTimeout(status.timer); status.timer = setTimeout(() => toast.classList.remove('show'), 3500);
}
function buttonLabel() { run.textContent = mode === 'compare' ? 'Compare schemas' : 'Validate payload'; }
function sizeLabel(bytes) { return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`; }
function refresh(editor) {
  const side = editor === left ? 'left' : 'right', gutter = $(`${side}-gutter`), size = $(`${side}-size`);
  const lines = editor.value.split('\n').length;
  if (gutter.lines !== lines) { gutter.textContent = Array.from({length: lines}, (_, i) => i + 1).join('\n'); gutter.lines = lines; }
  gutter.style.transform = `translateY(${-editor.scrollTop}px)`;
  const bytes = enc.encode(editor.value).length;
  size.textContent = bytes ? `${sizeLabel(bytes)} / 512 KB` : 'Empty'; size.classList.toggle('is-over', bytes > maximum);
}
function refreshAll() { refresh(left); refresh(right); }
function empty() {
  results.replaceChildren(); briefHost.replaceChildren(); results.classList.remove('loading');
  const box = element('div', 'empty-result'); const copy = element('div'); const icon = element('span', 'empty-icon', '{ }');
  icon.setAttribute('aria-hidden', 'true');
  copy.append(element('strong', '', 'Ready when you are.'), element('p', '', 'Load the example or paste your documents, then run a check.'));
  box.append(icon, copy); results.append(box); download.hidden = true; report = null;
}
function fail(message, title = 'The check could not run') {
  const box = element('div', 'results-error'); box.append(element('strong', '', title), element('span', '', message));
  results.replaceChildren(box); briefHost.replaceChildren();
  download.hidden = true; report = null;
}
function setBusy(value) {
  busy = value; results.setAttribute('aria-busy', String(value));
  for (const id of ['run-check','load-example','sample-select','clear-inputs','upload-left','upload-right','tab-validate','tab-compare']) $(id).disabled = value;
  left.readOnly = value; right.readOnly = value;
  if (!value) { results.classList.remove('loading'); buttonLabel(); }
}
function createWorker() {
  worker?.terminate(); worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
  worker.onmessage = event => {
    if (!pending || event.data.id !== pending.id) return;
    clearTimeout(timer); const resolve = pending.resolve, reject = pending.reject; pending = null;
    if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
  };
  worker.onerror = event => {
    event.preventDefault(); clearTimeout(timer);
    const reject = pending?.reject; pending = null; worker?.terminate(); worker = null;
    reject?.(new Error('The local worker could not complete this check. Reload the page and try a smaller document.'));
  };
}
function compute(a,b) {
  return new Promise((resolve,reject) => {
    if (!worker) createWorker();
    const id = ++requestId; pending = {id,resolve,reject};
    timer = setTimeout(() => {
      pending = null; worker?.terminate(); worker = null;
      reject(new Error('The check exceeded 8 seconds. Reduce complex patterns or document size and try again.'));
    }, 8000);
    worker.postMessage({id,mode,left:a,right:b});
  });
}
function parse(editor,label) {
  if (!editor.value.trim()) throw new Error(`${label} is empty. Paste JSON or load the example.`);
  if (enc.encode(editor.value).length > maximum) throw new Error(`${label} exceeds the 512 KB UTF-8 input limit.`);
  try { return JSON.parse(editor.value); } catch(error) { throw new Error(`${label} is not valid JSON. ${error.message}`); }
}
function finding(path,message,severity,index) {
  const row = element('div','change-row'); const copy = element('div');
  copy.append(element('div','change-path',path),element('div','change-message',message));
  row.append(element('span','change-index',String(index)),element('span',`tag ${severity}`,severity === 'invalid' ? 'Invalid' : severity[0].toUpperCase()+severity.slice(1)),copy); return row;
}
function count(n,label,severity) { return element('span',`count ${severity}${n ? '' : ' is-zero'}`,`${n} ${label}`); }
function render(value,duration) {
  results.replaceChildren();
  if (value.error) { fail(`Schema could not be evaluated. ${value.error}`); return; }
  const summary = element('div','results-summary'), head = element('div','results-head'), meta = element('div','results-meta');
  const total = mode === 'compare' ? value.changes.length : value.errors.length;
  const title = mode === 'compare' ? (total ? `${total} ${total === 1 ? 'change' : 'changes'} to review` : 'No structural changes detected') : value.valid ? 'Payload satisfies the schema' : 'Payload needs attention';
  const tone = mode === 'compare' ? (value.breaking ? 'fail' : total ? 'warn' : '') : value.valid ? '' : 'fail';
  const mark = element('span',`status-mark ${tone}`,tone ? '!' : '✓'); mark.setAttribute('aria-hidden','true');
  head.append(mark,element('div','results-title',title));
  if (mode === 'compare') meta.append(count(value.breaking,'breaking','breaking'),count(value.review,'review','review'),count(value.compatible,'compatible','compatible'),element('span','',`· ${Math.round(duration)} ms · local`));
  else meta.append(element('span','',`${total} ${total === 1 ? 'finding' : 'findings'} · ${Math.round(duration)} ms · local`));
  summary.append(head,meta); results.append(summary);
  const findings = mode === 'compare' ? value.changes : value.errors.map(x => ({...x,severity:'invalid'}));
  const listing = element('div','findings-list');
  findings.slice(0,200).forEach((item,i) => listing.append(finding(item.path,item.message,item.severity,i + 1)));
  if (findings.length) results.append(listing);
  if (findings.length > 200) results.append(element('p','results-note','Showing the first 200 findings. The downloaded report contains the full result.'));
  if (!total) results.append(element('p','results-note',mode === 'compare' ? 'No reviewed rules changed. This is not a proof of complete API compatibility.' : 'The input passed validation against the schema you provided.'));
  briefHost.replaceChildren(); if (mode === 'compare') mountExplainer(briefHost,value.changes);
  report = {tool:'Schema Labs',version:'1.0',mode,generatedAt:new Date().toISOString(),durationMs:Math.round(duration),result:value}; download.hidden = false;
}
function loadExample() {
  const { baseline, candidate, payload } = samples[sample];
  left.value = pretty(baseline); right.value = pretty(mode === 'compare' ? candidate : payload); refreshAll(); empty();
}
function selectMode(next,initial = false) {
  if (busy) return;
  mode = next;
  for (const name of ['validate','compare']) {
    const tab = $(`tab-${name}`), selected = name === mode;
    tab.setAttribute('aria-selected',String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  $('editor-area').setAttribute('aria-labelledby',`tab-${mode}`); document.querySelector('.tool').dataset.mode = mode;
  $('left-role').textContent = mode === 'compare' ? 'Before' : 'Contract'; $('right-role').textContent = mode === 'compare' ? 'After' : 'Data';
  $('left-label').textContent = mode === 'compare' ? 'Baseline schema' : 'JSON Schema';
  $('right-label').textContent = mode === 'compare' ? 'Candidate schema' : 'JSON payload';
  $('right-help').textContent = mode === 'compare' ? 'Review direction: baseline to candidate · up to 512 KB' : 'Editable sample data · documents stay in this tab';
  right.placeholder = mode === 'compare' ? 'Paste the candidate JSON Schema.' : 'Paste the JSON payload to validate.';
  buttonLabel(); loadExample();
  if (!initial) { const url = new URL(location.href); mode === 'compare' ? url.searchParams.set('mode','compare') : url.searchParams.delete('mode'); history.replaceState(null,'',url); }
}
run.addEventListener('click',async () => {
  if (busy) return;
  try {
    const a = parse(left,mode === 'compare' ? 'Baseline schema' : 'JSON Schema');
    const b = parse(right,mode === 'compare' ? 'Candidate schema' : 'JSON payload');
    setBusy(true); report = null; download.hidden = true;
    const loading = element('div','loading-state');
    loading.append(element('strong','','Checking in your browser…'),element('div','skeleton-line'),element('div','skeleton-line short'));
    results.replaceChildren(loading); run.textContent = 'Checking…';
    const start = performance.now(), value = await compute(a,b); render(value,performance.now()-start);
  } catch(error) { fail(error.message); } finally { setBusy(false); }
});
$('sample-select').addEventListener('change',event => { sample = event.target.value; loadExample(); run.click(); });
$('load-example').addEventListener('click',() => { loadExample(); status('Example loaded. Inputs are editable.'); });
$('clear-inputs').addEventListener('click',() => { left.value = ''; right.value = ''; refreshAll(); empty(); left.focus(); });
for (const name of ['validate','compare']) $(`tab-${name}`).addEventListener('click',() => selectMode(name));
for (const name of ['validate','compare']) $(`tab-${name}`).addEventListener('keydown',event => {
  if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
    event.preventDefault(); const target = event.key === 'Home' ? 'validate' : event.key === 'End' ? 'compare' : mode === 'validate' ? 'compare' : 'validate';
    selectMode(target); $(`tab-${target}`).focus();
  }
});
for (const editor of [left,right]) {
  editor.addEventListener('input',() => { refresh(editor); if(report) empty(); });
  editor.addEventListener('scroll',() => { $(`${editor === left ? 'left' : 'right'}-gutter`).style.transform = `translateY(${-editor.scrollTop}px)`; },{passive:true});
  editor.addEventListener('keydown',event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); run.click(); } });
}
let fileTarget = left;
for (const side of ['left','right']) $(`upload-${side}`).addEventListener('click',() => { fileTarget = side === 'left' ? left : right; $('file-input').value=''; $('file-input').click(); });
$('file-input').addEventListener('change',async event => {
  const file = event.target.files?.[0]; if(!file) return;
  try {
    if (file.size > maximum) throw new Error('That file exceeds the 512 KB input limit.');
    const text = await file.text(); JSON.parse(text); fileTarget.value = text; refresh(fileTarget); empty(); status('JSON file opened locally.');
  } catch(error) { fail(`Could not open the file. ${error.message}`,'File not opened'); }
});
download.addEventListener('click',() => {
  if(!report) return;
  const blob = new Blob([pretty(report)],{type:'application/json'}), url = URL.createObjectURL(blob), a = element('a');
  a.href=url; a.download=`schema-labs-${mode}-report.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
});
window.addEventListener('pagehide',() => { clearTimeout(timer); worker?.terminate(); });
selectMode(new URLSearchParams(location.search).get('mode') === 'compare' ? 'compare' : 'validate',true);
