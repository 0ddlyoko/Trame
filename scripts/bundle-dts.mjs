// Regroupe les déclarations de dist/types/ en un seul dist/trame.d.ts, à livrer à côté de trame.js.
//
// Chaque fichier devient un module ambiant `declare module "trame/internal/<chemin>"`, ses imports
// relatifs étant réécrits vers ces noms ; les points d'entrée publics sont exposés sous leurs noms
// d'import : "trame", "trame/testing", "trame/runtime", "trame/compiler".
// (Les outils habituels, dts-bundle-generator ou api-extractor, s'appuient sur l'API JavaScript de
// TypeScript, absente de TypeScript 7.)
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const INTERNAL = "trame/internal/";
const ENTRIES = {
    trame: "index",
    "trame/testing": "testing",
    "trame/runtime": "index.runtime",
    "trame/compiler": "compiler/index",
};

/** @returns {string[]} chemins relatifs (sans .d.ts, séparateurs /) des déclarations */
function listDeclarations(dir, root = dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            out.push(...listDeclarations(path, root));
        } else if (name.endsWith(".d.ts")) {
            out.push(relative(root, path).split(sep).join("/").slice(0, -".d.ts".length));
        }
    }
    return out.sort();
}

/**
 * @param {string} typesDir  dossier des déclarations émises par tsc (dist/types)
 * @param {string} outFile   fichier produit
 * @param {string} banner    commentaire d'en-tête
 */
export function bundleDeclarations(typesDir, outFile, banner) {
    const files = listDeclarations(typesDir);
    const known = new Set(files);
    const resolve = (from, spec) => {
        let target = posix.normalize(posix.join(posix.dirname(from), spec));
        if (target === "." || target === "") {
            target = "index";
        }
        if (!known.has(target) && known.has(`${target}/index`)) {
            target = `${target}/index`;
        }
        if (!known.has(target)) {
            throw new Error(`[bundle-dts] ${from}.d.ts : import introuvable « ${spec} »`);
        }
        return INTERNAL + target;
    };
    let out = `${banner}\n`;
    for (const file of files) {
        let code = readFileSync(join(typesDir, `${file}.d.ts`), "utf8").replace(/\r\n/g, "\n");
        code = code
            // Imports et exports relatifs → noms des modules internes
            .replace(/(\bfrom\s+|\bimport\s*\(\s*|^import\s+)"(\.{1,2}(?:\/[^"]*)?)"/gm, (_, head, spec) => `${head}"${resolve(file, spec)}"`)
            // Dans un module ambiant, les déclarations sont déjà ambiantes : pas de « declare »
            .replace(/^(export )?declare /gm, "$1")
            .replace(/^export \{\};\n?/gm, "")
            .trimEnd();
        const leftover = code.match(/(?:from\s+|import\s*\(\s*)"\.[^"]*"/);
        if (leftover) {
            throw new Error(`[bundle-dts] ${file}.d.ts : import relatif non réécrit (${leftover[0]})`);
        }
        const body = code.split("\n").map((line) => (line ? `    ${line}` : line)).join("\n");
        out += `\ndeclare module "${INTERNAL}${file}" {\n${body}\n}\n`;
    }
    for (const [name, target] of Object.entries(ENTRIES)) {
        if (!known.has(target)) {
            throw new Error(`[bundle-dts] point d'entrée ${name} : ${target}.d.ts introuvable`);
        }
        out += `\ndeclare module "${name}" {\n    export * from "${INTERNAL}${target}";\n}\n`;
    }
    writeFileSync(outFile, out);
    return out;
}

