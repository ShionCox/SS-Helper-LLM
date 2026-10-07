import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { compile } from 'svelte/compiler';

test('installed svelte-select compiles without HTML or accessibility warnings', () => {
    const require = createRequire(import.meta.url);
    const editorRequire = createRequire(require.resolve('svelte-jsoneditor/index.js'));
    const source = readFileSync(editorRequire.resolve('svelte-select/Select.svelte'), 'utf8');
    const { warnings } = compile(source, { filename: 'Select.svelte', generate: 'client', css: 'injected' });
    assert.deepEqual(warnings.map(({ code, message }) => ({ code, message })), []);
});
