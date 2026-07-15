import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const forbidden = [
  /(?:\.\.\/){2,}SDK\//,
  /(?:\.\.\/){2,}_Components\//,
  /window\.STX/,
  /globalSTX/,
  /\bSillyTavern\b/,
  /\bgetContext\s*\(/,
  /\beventSource\b/,
  /from\s+['"]@ss-helper\/sdk\//,
  /MemoryOS/i,
  /ss-helper-plugins-container/,
  /#extensions_settings/,
];
const shippedGuideForbidden = [
  /window\.STX/,
  /globalSTX/,
  /\bgetContext\s*\(/,
  /\beventSource\b/,
  /from\s+['"]@ss-helper\/sdk\//,
  /#extensions_settings/,
];

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (/\.(?:ts|js|json)$/.test(entry.name)) result.push(path);
  }
  return result;
}

const violations = [];
for (const path of await files('src')) {
  const text = await readFile(path, 'utf8');
  for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${relative('.', path)}: ${pattern}`);
}
for (const path of ['docs/integration-manual.md']) {
  const text = await readFile(path, 'utf8');
  for (const pattern of shippedGuideForbidden) if (pattern.test(text)) violations.push(`${relative('.', path)}: ${pattern}`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('legacy scan PASS');
}
