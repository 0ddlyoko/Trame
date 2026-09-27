// Construit la distribution :
//   dist/trame.js          module ES (un seul fichier), compatible navigateurs récents (ES2019)
//   dist/trame.min.js      idem, minifié
//   dist/trame.iife.js     script classique : variable globale `Trame`
//   dist/trame.runtime.js  sans compilateur de templates (templates précompilés), + .min.js
//   dist/trame-compiler.js compilateur de templates autonome, script (variable globale TrameCompiler),
//                          à embarquer côté serveur (QuickJS...) ; dist/compiler.js : même chose en module ES
//   dist/testing.js        utilitaires de test (trame/testing), qui importent « trame »
//   dist/trame-check.mjs   vérification des templates par TypeScript (npx trame-check)
//   dist/types/            déclarations TypeScript
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDeclarations } from "./bundle-dts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
rmSync(`${root}dist`, { recursive: true, force: true });

const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const banner = `/*! Trame v${version} | LGPL v3 | https://github.com/0ddlyoko/Trame */`;

const common = {
    entryPoints: [`${root}src/index.ts`],
    bundle: true,
    // ES2019 : Chrome 73+, Firefox 67+, Safari 12.1+, Edge 79+. Les syntaxes plus récentes
    // (champs privés, ?., ??...) sont converties par esbuild.
    target: ["es2019"],
    legalComments: "none",
    logLevel: "info",
    // Version (Trame.VERSION) et en-tête lus depuis package.json.
    define: { __TRAME_VERSION__: JSON.stringify(version) },
    banner: { js: banner },
};

await esbuild.build({ ...common, format: "esm", outfile: `${root}dist/trame.js`, sourcemap: true });
await esbuild.build({ ...common, format: "esm", outfile: `${root}dist/trame.min.js`, minify: true, sourcemap: true });
await esbuild.build({ ...common, format: "iife", globalName: "Trame", outfile: `${root}dist/trame.iife.js`, sourcemap: true });

// Version sans compilateur : les templates doivent être précompilés (registerCompiled).
const runtime = { ...common, entryPoints: [`${root}src/index.runtime.ts`], format: "esm", sourcemap: true };
await esbuild.build({ ...runtime, outfile: `${root}dist/trame.runtime.js` });
await esbuild.build({ ...runtime, outfile: `${root}dist/trame.runtime.min.js`, minify: true });

// Compilateur autonome (sans DOM), pour précompiler côté serveur.
const compilerEntry = { ...common, entryPoints: [`${root}src/compiler/index.ts`] };
await esbuild.build({ ...compilerEntry, format: "iife", globalName: "TrameCompiler", outfile: `${root}dist/trame-compiler.js`, minify: true });
await esbuild.build({ ...compilerEntry, format: "esm", outfile: `${root}dist/compiler.js` });

// trame/testing : Trame n'est pas recopié, il est importé sous son nom « trame » (une seule instance :
// l'import map de l'application, ou le paquet npm, résout ce nom vers le même fichier que l'application).
await esbuild.build({
    ...common,
    entryPoints: [`${root}src/testing.ts`],
    format: "esm",
    outfile: `${root}dist/testing.js`,
    plugins: [
        {
            name: "trame-external",
            setup(build) {
                build.onResolve({ filter: /^\.\/index$/ }, () => ({ path: "trame", external: true }));
            },
        },
    ],
});

// trame-check : outil en ligne de commande (Node)
await esbuild.build({
    entryPoints: [`${root}src/cli/check.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node20"],
    outfile: `${root}dist/trame-check.mjs`,
    banner: { js: `#!/usr/bin/env node
${banner}` },
    define: { __TRAME_VERSION__: JSON.stringify(version) },
    logLevel: "info",
});

const require = createRequire(import.meta.url);
const tscBin = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const tsc = spawnSync(process.execPath, [tscBin, "-p", `${root}tsconfig.build.json`], { stdio: "inherit" });
if (tsc.status !== 0) {
    process.exit(tsc.status ?? 1);
}
console.log("Déclarations TypeScript générées dans dist/types");

// Un seul fichier de types, à livrer à côté de trame.js, puis vérification : un projet consommateur
// (scripts/dts-check) doit compiler contre lui.
bundleDeclarations(`${root}dist/types`, `${root}dist/trame.d.ts`, `${banner}
// Déclarations de "trame", "trame/testing", "trame/runtime" et "trame/compiler".`);
const check = spawnSync(process.execPath, [tscBin, "-p", `${root}scripts/dts-check/tsconfig.json`], { stdio: "inherit" });
if (check.status !== 0) {
    console.error("dist/trame.d.ts : le projet de vérification (scripts/dts-check) ne compile pas");
    process.exit(check.status ?? 1);
}
console.log("Types regroupés dans dist/trame.d.ts (vérifiés)");
