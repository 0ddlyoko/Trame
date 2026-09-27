// Construction des pages mesurées par run.mjs et memory.mjs.
// - Sans ref : la copie de travail (Trame), plus OWL 3 s'il est installé.
// - Avec des refs git : chaque commit est extrait dans un worktree temporaire et construit avec la même
//   page (les commits de la branche d'expérimentation importaient un interrupteur, retiré ici).
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const head = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div>`;
// OWL applique le DOM dans un requestAnimationFrame : remplacé par un microtask avant son chargement.
const rafShim = `<script>window.requestAnimationFrame = (cb) => { Promise.resolve().then(() => cb(performance.now())); return 1; };</script>`;

/**
 * @param {string[]} refs  commits à mesurer (vide : copie de travail)
 * @param {{ wide?: boolean }} options  ajoute les variantes « 30 champs »
 * @returns {Promise<{ variants: { name: string, url: string }[], cleanup: () => void }>}
 */
export async function buildVariants(refs, { wide = true } = {}) {
    const dist = join(root, "bench", "dist", "variants");
    mkdirSync(dist, { recursive: true });
    const pageSource = readFileSync(join(root, "bench", "props", "page.ts"), "utf8")
        .replace(/^import \{ setComputedPropsCache \}.*$/m, "")
        .replace(/^setComputedPropsCache\(.*$/m, "");
    const variants = [];
    const worktrees = [];
    const add = (name, file, shim = "") => {
        writeFileSync(join(dist, `${file}.html`), `${head}${shim}<script src="${file}"></script></body></html>`);
        const url = pathToFileURL(join(dist, `${file}.html`)).href;
        variants.push({ name, url });
        if (wide) variants.push({ name: `${name} 30 ch.`, url: `${url}?wide=1` });
    };
    const buildTrame = async (name, srcRoot) => {
        // Fichier temporaire à côté de page.ts (mêmes imports relatifs vers src/).
        const entry = join(srcRoot, "bench", "props", ".variant-page.ts");
        mkdirSync(join(srcRoot, "bench", "props"), { recursive: true });
        writeFileSync(entry, pageSource);
        const file = `trame-${variants.length}.js`;
        try {
            await esbuild.build({ entryPoints: [entry], bundle: true, format: "iife", target: ["es2022"], minify: true, outfile: join(dist, file), logLevel: "warning" });
        } finally {
            rmSync(entry, { force: true });
        }
        add(name, file);
    };
    if (refs.length === 0) {
        await buildTrame("Trame", root);
    } else {
        for (const ref of refs) {
            const dir = mkdtempSync(join(tmpdir(), "trame-wt-"));
            execFileSync("git", ["worktree", "add", "--detach", dir, ref], { cwd: root, stdio: "ignore" });
            worktrees.push(dir);
            await buildTrame(ref, dir);
        }
    }
    if (existsSync(join(root, "node_modules", "@odoo", "owl"))) {
        await esbuild.build({ entryPoints: [join(root, "bench", "props", "page-owl.ts")], bundle: true, format: "iife", target: ["es2022"], minify: true, outfile: join(dist, "owl.js"), logLevel: "warning" });
        add("OWL 3", "owl.js", rafShim);
    }
    const cleanup = () => {
        for (const dir of worktrees) {
            execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: root, stdio: "ignore" });
        }
    };
    return { variants, cleanup };
}
