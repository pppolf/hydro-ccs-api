const path = require('node:path');
const ts = require('typescript');

// Hydro ships its host API as .ts sources using a non-strict configuration.
// Resolve those real types, but apply this plugin's strict checks to its own
// sources. skipLibCheck only skips .d.ts, not the host's .ts implementation.
const root = path.resolve(__dirname, '..');
const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config || {}, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const owned = new Set(parsed.fileNames.map(file => path.resolve(file)));
const diagnostics = [
    ...(configFile.error ? [configFile.error] : []),
    ...parsed.errors,
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSourceFiles().filter(file => owned.has(path.resolve(file.fileName)))
        .flatMap(file => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]),
];
if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: file => file,
        getNewLine: () => '\n',
    }));
    process.exitCode = 1;
} else {
    console.log(`Typechecked ${owned.size} plugin source files against the installed Hydro API types.`);
}
