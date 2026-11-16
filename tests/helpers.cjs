const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Load the real plugin source while replacing only the Hydro host services.
exports.loader = function loader(hydro = {}) {
    const cache = new Map();
    function load(name, directory = path.resolve(__dirname, '../src')) {
        const filename = path.resolve(directory, name.endsWith('.ts') ? name : `${name}.ts`);
        if (cache.has(filename)) return cache.get(filename).exports;
        const mod = new Module(filename, module);
        cache.set(filename, mod);
        mod.filename = filename;
        mod.paths = module.paths;
        const original = mod.require.bind(mod);
        mod.require = request => request === 'hydrooj' ? hydro
            : request.startsWith('.') ? load(request, path.dirname(filename)) : original(request);
        mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
        }).outputText, filename);
        return mod.exports;
    }
    return load;
};
