// Rewrites ?v=<12-hex sha256> on every /assets/ URL in public/*.html and public/assets/site.css so caches follow content.
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
const pub = new URL('../public/', import.meta.url);
const hash = async path => createHash('sha256').update(await readFile(new URL(path, pub))).digest('hex').slice(0, 12);
const stamp = async file => {
  const text = await readFile(new URL(file, pub), 'utf8');
  const urls = [...new Set([...text.matchAll(/\/assets\/[\w./-]+\?v=[0-9a-f]{12}/g)].map(m => m[0]))];
  let out = text;
  for (const url of urls) {
    const path = url.slice(1, url.indexOf('?'));
    out = out.replaceAll(url, `/${path}?v=${await hash(path)}`);
  }
  if (out !== text) await writeFile(new URL(file, pub), out);
};
await stamp('assets/site.css'); // fonts first: site.css content feeds its own hash
for (const file of (await readdir(pub)).filter(f => f.endsWith('.html'))) await stamp(file);
