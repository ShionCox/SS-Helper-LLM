import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

function createSyntheticModule(context, identifier, exportsObject) {
  const exportNames = Object.keys(exportsObject);
  return new vm.SyntheticModule(
    exportNames,
    function initialize() {
      for (const name of exportNames) {
        this.setExport(name, exportsObject[name]);
      }
    },
    { context, identifier },
  );
}

async function resolveRelativeImport(specifier, referencingIdentifier) {
  const referrerPath = fileURLToPath(referencingIdentifier);
  const unresolved = path.resolve(path.dirname(referrerPath), specifier);
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [unresolved, `${unresolved}.ts`, path.join(unresolved, 'index.ts')];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // 继续尝试下一个 TypeScript 解析候选。
    }
  }
  return unresolved;
}

/**
 * 在隔离 VM 中加载旧 TypeScript 模块，并允许替换其宿主/数据库依赖。
 * 该工具只服务于复制基线测试，不改变生产源码的解析或运行方式。
 */
export async function loadTypeScriptModule(entryPath, options = {}) {
  const stubs = options.stubs ?? {};
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Date,
    Promise,
    Map,
    Set,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Response,
    Request,
    Headers,
    fetch,
    btoa,
    atob,
    ...options.globals,
  });
  const moduleCache = new Map();

  async function loadFile(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (moduleCache.has(resolvedPath)) {
      return moduleCache.get(resolvedPath);
    }

    const source = await readFile(resolvedPath, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      },
      fileName: resolvedPath,
    }).outputText;
    const identifier = pathToFileURL(resolvedPath).href;
    const module = new vm.SourceTextModule(output, { context, identifier });
    moduleCache.set(resolvedPath, module);

    await module.link(async (specifier, referencingModule) => {
      if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
        const stubKey = `stub:${specifier}`;
        if (!moduleCache.has(stubKey)) {
          moduleCache.set(stubKey, createSyntheticModule(context, stubKey, stubs[specifier]));
        }
        return moduleCache.get(stubKey);
      }

      if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
        throw new Error(`未提供裸模块替身: ${specifier}`);
      }

      const dependencyPath = await resolveRelativeImport(specifier, referencingModule.identifier);
      if (Object.prototype.hasOwnProperty.call(stubs, dependencyPath)) {
        const stubKey = `stub:${dependencyPath}`;
        if (!moduleCache.has(stubKey)) {
          moduleCache.set(stubKey, createSyntheticModule(context, stubKey, stubs[dependencyPath]));
        }
        return moduleCache.get(stubKey);
      }
      return loadFile(dependencyPath);
    });
    await module.evaluate();
    return module;
  }

  const entryModule = await loadFile(entryPath);
  return entryModule.namespace;
}

