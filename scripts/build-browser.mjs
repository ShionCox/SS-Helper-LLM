import esbuild from 'esbuild';
import sveltePlugin from 'esbuild-svelte';

const browserBuild = (entryPoint, outfile) => esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
  mainFields: ['svelte', 'browser', 'module', 'main'],
  conditions: ['svelte', 'browser'],
  plugins: [sveltePlugin({ compilerOptions: { css: 'injected' } })],
  logLevel: 'info',
});

await browserBuild('src/index.ts', 'dist/index.js');
await browserBuild('src/runtime-entry.ts', 'dist/runtime-entry.js');
await esbuild.build({
  entryPoints: ['src/ui/request-log-viewer.css'],
  bundle: true,
  outfile: 'dist/style.css',
  logLevel: 'info',
});
await import('./verify-browser-artifact.mjs');
