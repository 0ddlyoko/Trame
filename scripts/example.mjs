// Démo : compile examples/order et la sert sur http://localhost:8000
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const ctx = await esbuild.context({
    entryPoints: [`${root}examples/order/main.ts`],
    bundle: true,
    format: "esm",
    target: ["es2019"],
    sourcemap: true,
    outfile: `${root}examples/order/main.js`,
    alias: { trame: `${root}src/index.ts` },
    logLevel: "info",
});

await ctx.watch();
const { port } = await ctx.serve({ servedir: `${root}examples/order`, port: 8000 });
console.log(`Démo disponible sur http://localhost:${port}`);
