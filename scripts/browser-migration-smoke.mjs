import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');

function browserExecutable() {
  const candidates = process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!executable) throw new Error('No approved Chrome or Edge executable was found');
  return executable;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(callback, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('Timed out');
}

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true });
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

const browserHarness = String.raw`
import Dexie from 'dexie';
import {
  CUTOVER_MARKER_KEY,
  LEGACY_DATABASE_NAME,
  LLM_DATABASE_NAME,
  ROLLBACK_BACKUP_KEY,
  ROLLBACK_EVIDENCE_KEY,
  migrateLlmDatabase,
  rollbackLlmDatabase,
} from './src/storage/database.ts';

const legacyStores = {
  chat_documents: '&chatKey, entityKey, updatedAt',
  chat_plugin_state: '&[pluginId+chatKey], pluginId, chatKey, updatedAt',
  chat_plugin_records: '++id, pluginId, chatKey, collection, recordId, ts, updatedAt, [pluginId+chatKey+collection], [pluginId+chatKey+collection+ts]',
  events: '&eventId, chatKey, ts, type, [chatKey+ts], [chatKey+type+ts]',
  templates: '&templateId, chatKey, [chatKey+createdAt], updatedAt',
  audit: '&auditId, chatKey, ts',
  meta: '&chatKey, updatedAt',
  memory_mutation_history: '&historyId, chatKey, [chatKey+ts], ts',
  memory_entry_audit_records: '&auditId, chatKey, entryId, summaryId, actionType, [chatKey+ts], [chatKey+entryId], ts',
  memory_entries: '&entryId, chatKey, [chatKey+entryType], [chatKey+category], [chatKey+updatedAt], updatedAt',
  memory_entry_types: '&typeId, chatKey, [chatKey+key], [chatKey+updatedAt]',
  actor_memory_profiles: '&[chatKey+actorKey], chatKey, actorKey, [chatKey+updatedAt]',
  role_entry_memory: '&roleMemoryId, chatKey, [chatKey+actorKey], [chatKey+entryId], [chatKey+actorKey+entryId], [chatKey+updatedAt]',
  memory_relationships: '&relationshipId, chatKey, [chatKey+sourceActorKey], [chatKey+targetActorKey], [chatKey+sourceActorKey+targetActorKey], [chatKey+updatedAt], updatedAt',
  summary_snapshots: '&summaryId, chatKey, [chatKey+updatedAt]',
  world_profile_bindings: '&chatKey, primaryProfile, updatedAt',
  llm_credentials: '&providerId, updatedAt',
  llm_request_logs: '&logId, requestId, sourcePluginId, sortTs, state, [sourcePluginId+sortTs], [state+sortTs], updatedAt',
};

function check(condition, message) { if (!condition) throw new Error(message); }

window.runMigrationSmoke = async () => {
  const vaultName = 'stx_llm_vault';
  await Promise.all([Dexie.delete(LEGACY_DATABASE_NAME), Dexie.delete(LLM_DATABASE_NAME), Dexie.delete(vaultName)]);
  try {
    const legacy = new Dexie(LEGACY_DATABASE_NAME);
    legacy.version(4).stores(legacyStores);
    await legacy.open();
    await legacy.table('llm_credentials').bulkPut([
      { providerId: 'mixed', updatedAt: 20, payload: { apiKey: 'mixed-key' } },
      { providerId: 'tie', updatedAt: 30, payload: { apiKey: 'mixed-tie' } },
    ]);
    await legacy.table('llm_request_logs').put({ logId: 'log-a', requestId: 'request-a', sourcePluginId: 'consumer-a', sortTs: 20, state: 'completed', updatedAt: 20, payload: { private: true } });
    await legacy.table('chat_documents').put({ chatKey: 'keep', entityKey: 'unrelated', updatedAt: 1, payload: { untouched: true } });
    const unrelatedBefore = JSON.stringify(await legacy.table('chat_documents').toArray());
    const legacySchemaBefore = JSON.stringify(legacy.tables.map((table) => ({ name: table.name, primary: table.schema.primKey.src, indexes: table.schema.indexes.map((index) => index.src).sort() })).sort((a, b) => a.name.localeCompare(b.name)));
    legacy.close();

    const vault = new Dexie(vaultName);
    vault.version(1).stores({ credentials: '&resourceId, updatedAt' });
    await vault.open();
    await vault.table('credentials').bulkPut([
      { resourceId: 'vault-only', updatedAt: 40, key: 'vault-key' },
      { resourceId: 'mixed', updatedAt: 10, key: 'old-vault-key' },
      { resourceId: 'tie', updatedAt: 30, key: 'vault-tie' },
    ]);
    vault.close();

    const failed = await migrateLlmDatabase({ faultAt: 'marker-write' });
    check(!failed.cutover, 'fault must not cut over');
    check(await failed.database.migration_evidence.get(CUTOVER_MARKER_KEY) === undefined, 'fault must not write marker');
    check(await failed.database.llm_credentials.count() === 0 && await failed.database.llm_request_logs.count() === 0, 'fault transaction must roll back target rows');
    failed.fallbackDatabase?.close();
    failed.database.close();

    const migrated = await migrateLlmDatabase();
    check(migrated.cutover && migrated.evidence?.state === 'cutover', 'retry must cut over');
    check(migrated.evidence.sourceDatabase === LEGACY_DATABASE_NAME && migrated.evidence.sourceVersion === 4, 'source metadata mismatch');
    check(migrated.evidence.targetDatabase === LLM_DATABASE_NAME && migrated.evidence.targetVersion === 1, 'target metadata mismatch');
    check((await migrated.database.llm_credentials.get('mixed')).payload.apiKey === 'mixed-key', 'newer mixed credential must win');
    check((await migrated.database.llm_credentials.get('tie')).payload.apiKey === 'mixed-tie', 'mixed credential must win ties');
    check((await migrated.database.llm_credentials.get('vault-only')).payload.apiKey === 'vault-key', 'vault-only credential missing');
    check((await migrated.database.llm_request_logs.where('[sourcePluginId+sortTs]').equals(['consumer-a', 20]).primaryKeys()).includes('log-a'), 'source compound index mismatch');
    check((await migrated.database.llm_request_logs.where('[state+sortTs]').equals(['completed', 20]).primaryKeys()).includes('log-a'), 'state compound index mismatch');
    const targetStores = migrated.database.tables.map((table) => table.name).sort();
    check(JSON.stringify(targetStores) === JSON.stringify(['llm_credentials', 'llm_request_logs', 'migration_evidence']), 'target store ownership mismatch');
    await migrated.database.llm_credentials.put({ providerId: 'target-only', updatedAt: 99, payload: { apiKey: 'target' } });
    migrated.database.close();

    const second = await migrateLlmDatabase();
    check(await second.database.llm_credentials.get('target-only') !== undefined, 'idempotent startup overwrote target data');
    second.database.close();

    const legacyAfterCutover = new Dexie(LEGACY_DATABASE_NAME);
    await legacyAfterCutover.open();
    check(legacyAfterCutover.verno === 4, 'legacy version changed');
    check(JSON.stringify(await legacyAfterCutover.table('chat_documents').toArray()) === unrelatedBefore, 'unrelated data changed during cutover');
    const legacySchemaAfter = JSON.stringify(legacyAfterCutover.tables.map((table) => ({ name: table.name, primary: table.schema.primKey.src, indexes: table.schema.indexes.map((index) => index.src).sort() })).sort((a, b) => a.name.localeCompare(b.name)));
    check(legacySchemaAfter === legacySchemaBefore, 'legacy schema changed during cutover: ' + legacySchemaBefore + ' != ' + legacySchemaAfter);
    const legacyCredentialsBeforeRollback = JSON.stringify(await legacyAfterCutover.table('llm_credentials').toArray());
    legacyAfterCutover.close();

    let rollbackFault = '';
    try { await rollbackLlmDatabase({ rollbackFaultAt: 'logs-write' }); } catch (error) { rollbackFault = String(error.message); }
    check(rollbackFault.includes('Injected logs-write failure'), 'rollback fault was not surfaced');
    const legacyAfterFault = new Dexie(LEGACY_DATABASE_NAME);
    await legacyAfterFault.open();
    check(JSON.stringify(await legacyAfterFault.table('llm_credentials').toArray()) === legacyCredentialsBeforeRollback, 'failed rollback changed legacy LLM rows');
    legacyAfterFault.close();

    const rollback = await rollbackLlmDatabase();
    check(rollback.key === ROLLBACK_EVIDENCE_KEY && rollback.state === 'rolled-back', 'rollback evidence mismatch');
    const targetAfterRollback = new Dexie(LLM_DATABASE_NAME);
    await targetAfterRollback.open();
    check((await targetAfterRollback.table('migration_evidence').get(CUTOVER_MARKER_KEY)).state === 'cutover', 'rollback overwrote cutover marker');
    check(await targetAfterRollback.table('migration_evidence').get(ROLLBACK_BACKUP_KEY) !== undefined, 'rollback backup evidence missing');
    check(await targetAfterRollback.table('migration_evidence').get(ROLLBACK_EVIDENCE_KEY) !== undefined, 'rollback success evidence missing');
    targetAfterRollback.close();

    const legacyAfterRollback = new Dexie(LEGACY_DATABASE_NAME);
    await legacyAfterRollback.open();
    check(await legacyAfterRollback.table('llm_credentials').get('target-only') !== undefined, 'rollback did not restore target LLM row');
    check(JSON.stringify(await legacyAfterRollback.table('chat_documents').toArray()) === unrelatedBefore, 'rollback changed unrelated data');
    check(legacyAfterRollback.verno === 4, 'rollback changed legacy version');
    legacyAfterRollback.close();

    const retained = (await indexedDB.databases()).map(({ name, version }) => ({ name, version })).sort((a, b) => a.name.localeCompare(b.name));
    check(retained.some(({ name, version }) => name === LEGACY_DATABASE_NAME && version === 40), 'legacy database was not retained at Dexie v4');
    check(retained.some(({ name, version }) => name === LLM_DATABASE_NAME && version === 10), 'target database missing at Dexie v1');
    check(retained.some(({ name }) => name === vaultName), 'legacy vault was deleted');
    return { userAgent: navigator.userAgent, retained, targetStores, cutover: migrated.evidence, rollback };
  } finally {
    await Promise.all([Dexie.delete(LEGACY_DATABASE_NAME), Dexie.delete(LLM_DATABASE_NAME), Dexie.delete(vaultName)]);
  }
};
`;

const temp = mkdtempSync(path.join(os.tmpdir(), 'ss-helper-llm-browser-'));
const bundle = path.join(temp, 'bundle.js');
const profile = path.join(temp, 'profile');
let browser;
let server;
let session;
try {
  await build({ stdin: { contents: browserHarness, resolveDir: root, sourcefile: 'browser-migration-smoke.ts' }, bundle: true, format: 'iife', platform: 'browser', outfile: bundle, logLevel: 'silent' });
  writeFileSync(path.join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="/bundle.js"></script>');
  const port = await freePort();
  server = http.createServer((request, response) => {
    const file = request.url === '/bundle.js' ? bundle : path.join(temp, 'index.html');
    response.setHeader('content-type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const debugPort = await freePort();
  browser = spawn(browserExecutable(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`,
  ], { stdio: 'ignore', windowsHide: true });
  const page = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
    const pages = await response.json();
    return pages.find((entry) => entry.type === 'page' && entry.url.startsWith(`http://127.0.0.1:${port}/`));
  });
  session = new CdpSession(page.webSocketDebuggerUrl);
  await session.open();
  await waitFor(async () => {
    const ready = await session.send('Runtime.evaluate', { expression: 'typeof window.runMigrationSmoke === "function"', returnByValue: true });
    return ready.result.value === true;
  });
  const evaluation = await session.send('Runtime.evaluate', { expression: 'window.runMigrationSmoke()', awaitPromise: true, returnByValue: true });
  if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
  const evidence = evaluation.result.value;
  assert.match(evidence.userAgent, /(Chrome|Edg)\//);
  console.log(JSON.stringify({ status: 'PASS', runtime: 'real-browser-indexeddb', ...evidence }, null, 2));
} finally {
  session?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  stop(browser);
  rmSync(temp, { recursive: true, force: true });
}
