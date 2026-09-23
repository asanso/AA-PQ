#!/usr/bin/env node
// The visible header label is the source of truth for the README version badge.
import {readFile, writeFile, mkdir} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/sync-portal-version.mjs [--check]');
const html = await readFile(new URL('frontend/public/index.html', root), 'utf8');
const matches = [...html.matchAll(/<span\b[^>]*\bid="portalVersion"[^>]*>version (\d+\.\d+(?:\.\d+)?)<\/span>/g)];
if (matches.length !== 1) throw new Error('Expected one portalVersion label with a numeric version.');
const version = matches[0][1];
const label = 'version ' + version;
const width = 24 + label.length * 7;
const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="22" viewBox="0 0 ' + width + ' 22" role="img" aria-label="' + label + '">',
  '  <title>' + label + '</title>',
  '  <rect x=".5" y=".5" width="' + (width - 1) + '" height="21" rx="4" fill="#f6f8fa" stroke="#d1d9e0"/>',
  '  <text x="' + width / 2 + '" y="15" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" fill="#34424b">' + label + '</text>',
  '</svg>', ''
].join('\n');
const readmeUrl = new URL('README.md', root);
const readme = await readFile(readmeUrl, 'utf8');
const marker = /<!-- portal-version:start -->[\s\S]*?<!-- portal-version:end -->/g;
if ([...readme.matchAll(marker)].length !== 1) throw new Error('Expected one README portal-version block.');
const block = '<!-- portal-version:start -->\n![' + label + '](docs/assets/portal-version.svg)\n<!-- portal-version:end -->';
const expectedReadme = readme.replace(marker, block);
const badgeUrl = new URL('docs/assets/portal-version.svg', root);
if (check) {
  const badge = await readFile(badgeUrl, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (readme !== expectedReadme || badge !== svg) throw new Error('Version badge is out of date. Run node scripts/sync-portal-version.mjs.');
  console.log('Portal and README version match: ' + version);
} else {
  await mkdir(new URL('docs/assets/', root), {recursive:true});
  await writeFile(badgeUrl, svg);
  await writeFile(readmeUrl, expectedReadme);
  console.log('Updated README badge: ' + label);
}
