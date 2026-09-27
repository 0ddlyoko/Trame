// @vitest-environment node
// Les fichiers distribués doivent être en ASCII pur : servis sans « charset=utf-8 » (ou embarqués dans un
// moteur qui lit les octets en Latin-1), un caractère non ASCII brut (dans une regex, par exemple) est
// mal décodé et le script plante au chargement.
import * as esbuild from "esbuild";
import { describe, expect, test } from "vitest";

const entries = [
    ["trame.min.js", "src/index.ts", "esm"],
    ["trame.runtime.min.js", "src/index.runtime.ts", "esm"],
    ["trame-compiler.js", "src/compiler/index.ts", "iife"],
] as const;

describe("bundles distribués", () => {
    for (const [name, entry, format] of entries) {
        test(`${name} ne contient que des caractères ASCII`, async () => {
            const result = await esbuild.build({
                entryPoints: [entry], // relatif au dossier du projet (dossier courant des tests)
                bundle: true,
                target: ["es2019"],
                format,
                minify: true,
                write: false,
                legalComments: "none",
                logLevel: "silent",
            });
            const code = result.outputFiles[0].text;
            const offenders = [...code.matchAll(/[^\x00-\x7f]/g)].map((m) => code.slice(Math.max(0, m.index! - 30), m.index! + 10));
            expect(offenders).toEqual([]);
        }, 30000);
    }
});
