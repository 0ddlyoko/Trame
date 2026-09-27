// Benchmark comparatif Trame / OWL 3 sur une liste de 1000 lignes (dans jsdom).
// OWL n'est pas une dépendance du projet : installez-le sans l'enregistrer avant de lancer :
//   npm install --no-save @odoo/owl@3.0.0-alpha.49
//   npm run bench
// Attention : jsdom n'est pas un vrai navigateur ; les chiffres donnent une tendance, pas une mesure absolue.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
try {
    require.resolve("@odoo/owl/package.json");
} catch {
    console.error("OWL n'est pas installé : npm install --no-save @odoo/owl@3.0.0-alpha.49");
    process.exit(1);
}

await esbuild.build({
    entryPoints: [`${root}bench/list.bench.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["es2022"],
    outfile: `${root}bench/dist/list.bench.mjs`,
    external: ["jsdom"],
    logLevel: "warning",
});
const result = spawnSync(process.execPath, [`${root}bench/dist/list.bench.mjs`], { stdio: "inherit" });
process.exit(result.status ?? 1);
