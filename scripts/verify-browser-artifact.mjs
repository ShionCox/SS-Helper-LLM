import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputs = ['dist/index.js', 'dist/runtime-entry.js'];
const bareStaticImport = /^\s*import(?:\s+[^'"\r\n]+?\s+from)?\s*["'](?![./]|https?:|data:|blob:)[^"']+["']/mu;
const bareDynamicImport = /\bimport\s*\(\s*["'](?![./]|https?:|data:|blob:)[^"']+["']/u;
const forbiddenCoreOwnership = /(?:installCoreRuntime|createSillyTavernHostBridge|silly-tavern-adapter)/u;
const forbiddenServerAndSecrets = /(?:secretGet|secretSet|WorkspaceSecretRecord|@ss-helper\/sdk\/server|connectServerPlugin|node:(?:http|https|dns)|\/api\/plugins\/ss-helper-llm)/u;
const forbiddenHardcodedCredential = /(?:sk-[A-Za-z0-9]{16,}|api_key\s*[:=]\s*['"][^'"]{12,}['"])/u;

for (const relative of outputs) {
  const source = readFileSync(path.join(root, relative), 'utf8');
  assert.equal(bareStaticImport.test(source) || bareDynamicImport.test(source), false, `${relative} contains a browser-unresolvable bare import`);
  assert.equal(forbiddenCoreOwnership.test(source), false, `${relative} embeds Core/Tavern adapter ownership`);
  assert.equal(forbiddenServerAndSecrets.test(source), false, `${relative} embeds removed server or Secret API code`);
  assert.equal(forbiddenHardcodedCredential.test(source), false, `${relative} embeds a hard-coded credential`);
}

console.log('browser artifact scan PASS');
