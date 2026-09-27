// Vérifie les templates avec TypeScript (outil trame-check), sans passer par le build complet.
//   node scripts/check-templates.mjs [-p tsconfig.json] [dossiers...]
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}.trame/trame-check.mjs`;
await esbuild.build({
    entryPoints: [`${root}src/cli/check.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node20"],
    outfile: out,
    logLevel: "warning",
});
const result = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd() });
process.exit(result.status ?? 1);
