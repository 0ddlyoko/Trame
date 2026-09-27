/**
 * trame-check : vérifie les templates des composants avec TypeScript.
 *
 *   trame-check [-p tsconfig.json] [dossiers ou fichiers...]
 *
 * 1. Trouve les templates inline (`static template = xml\`...\``) dans les fichiers .ts.
 * 2. Copie le projet dans .trame/check/ en insérant, dans chaque classe, du code de vérification
 *    qui reprend les expressions du template avec les vrais types.
 * 3. Lance `tsc` sur cette copie et rapporte les erreurs sur la ligne du template.
 *
 * Code de sortie : 0 si tout est correct, 1 s'il y a des erreurs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { checkPrelude, generateCheck } from "../compiler/typecheck";

interface FoundTemplate {
    className: string;
    source: string;
    /** Ligne (dans le fichier .ts) du premier caractère du template. */
    line: number;
    /** Position de l'accolade fermante de la classe (insertion du code de vérification). */
    classEnd: number;
}

interface Mapping {
    file: string;
    generatedLine: number;
    sourceLine: number | undefined;
    className: string;
}

const MAX_FILE_SIZE = 2_000_000;

// --- Lecture du code source ----------------------------------------------------------------------

/** Saute une chaîne ou un template literal à partir de `i` (sur le guillemet ouvrant). Renvoie l'index après. */
function skipString(code: string, i: number): number {
    const quote = code[i];
    i++;
    while (i < code.length) {
        const c = code[i];
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === quote) {
            return i + 1;
        }
        if (quote === "`" && c === "$" && code[i + 1] === "{") {
            i = skipBraces(code, i + 1);
            continue;
        }
        i++;
    }
    return i;
}

/** À partir d'une accolade ouvrante, renvoie l'index juste après l'accolade fermante correspondante. */
function skipBraces(code: string, i: number): number {
    let depth = 0;
    while (i < code.length) {
        const c = code[i];
        if (c === '"' || c === "'" || c === "`") {
            i = skipString(code, i);
            continue;
        }
        if (c === "/" && code[i + 1] === "/") {
            const end = code.indexOf("\n", i);
            i = end === -1 ? code.length : end;
            continue;
        }
        if (c === "/" && code[i + 1] === "*") {
            const end = code.indexOf("*/", i + 2);
            i = end === -1 ? code.length : end + 2;
            continue;
        }
        if (c === "{") {
            depth++;
        } else if (c === "}") {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
        i++;
    }
    return i;
}

function lineOf(code: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index; i++) {
        if (code.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}

/** Contenu « cuit » d'un template literal (échappements \` \$ \\ résolus). */
function cook(raw: string): string {
    return raw.replace(/\\([`$\\])/g, "$1");
}

/** Trouve les templates inline des classes d'un fichier. */
export function findTemplates(code: string): { templates: FoundTemplate[]; skipped: string[] } {
    const templates: FoundTemplate[] = [];
    const skipped: string[] = [];
    const classRe = /\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g;
    let match: RegExpExecArray | null;
    while ((match = classRe.exec(code)) !== null) {
        const className = match[1];
        const bodyStart = match.index + match[0].length - 1;
        const bodyEnd = skipBraces(code, bodyStart) - 1;
        const body = code.slice(bodyStart, bodyEnd);
        const tpl = /static\s+(?:override\s+)?template\s*=\s*xml\s*`/.exec(body);
        if (tpl === null) {
            continue;
        }
        const contentStart = bodyStart + tpl.index + tpl[0].length;
        // Fin du template literal
        let i = contentStart;
        let interpolated = false;
        while (i < code.length && code[i] !== "`") {
            if (code[i] === "\\") {
                i += 2;
                continue;
            }
            if (code[i] === "$" && code[i + 1] === "{") {
                interpolated = true;
                i = skipBraces(code, i + 1);
                continue;
            }
            i++;
        }
        if (interpolated) {
            skipped.push(`${className} (template avec \${...}, non vérifié)`);
            continue;
        }
        templates.push({ className, source: cook(code.slice(contentStart, i)), line: lineOf(code, contentStart), classEnd: bodyEnd });
    }
    return { templates, skipped };
}

/** Module d'où le fichier importe Trame (pour les types utilisés par le code généré). */
function trameModuleOf(code: string): string {
    const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(code)) !== null) {
        if (/\b(Component|xml)\b/.test(match[1])) {
            return match[2];
        }
    }
    return "trame";
}

// --- Projet --------------------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> {
    const text = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text) as Record<string, unknown>;
}

function collectFiles(path: string, out: string[]): void {
    if (!existsSync(path)) {
        return;
    }
    const stat = statSync(path);
    if (stat.isFile()) {
        if (path.endsWith(".ts") && !path.endsWith(".d.ts") && stat.size < MAX_FILE_SIZE) {
            out.push(path);
        }
        return;
    }
    for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry === ".trame" || entry === "dist" || entry.startsWith(".")) {
            continue;
        }
        collectFiles(join(path, entry), out);
    }
}

function parseArgs(argv: string[]): { project: string; roots: string[] } {
    let project = "tsconfig.json";
    const roots: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "-p" || argv[i] === "--project") {
            project = argv[++i];
        } else {
            roots.push(argv[i]);
        }
    }
    return { project, roots };
}

// --- Programme principal -------------------------------------------------------------------------

export function main(argv: string[]): number {
    const cwd = process.cwd();
    const { project, roots: rootArgs } = parseArgs(argv);
    const projectPath = resolve(cwd, project);
    if (!existsSync(projectPath)) {
        console.error(`[trame-check] tsconfig introuvable : ${project}`);
        return 2;
    }
    const projectDir = dirname(projectPath);
    let roots = rootArgs;
    if (roots.length === 0) {
        const include = (readJson(projectPath).include as string[] | undefined) ?? ["."];
        roots = include.map((p) => p.split("*")[0] || ".");
    }

    const files: string[] = [];
    for (const root of roots) {
        collectFiles(resolve(projectDir, root), files);
    }

    const outDir = join(projectDir, ".trame", "check");
    rmSync(outDir, { recursive: true, force: true });
    const mappings: Mapping[] = [];
    let templateCount = 0;
    const skippedAll: string[] = [];

    // Copie de tous les fichiers .ts inclus (les imports relatifs restent valides), avec insertion
    // du code de vérification dans les classes qui ont un template.
    const all: string[] = [];
    collectFiles(projectDir, all);
    const toCheck = new Set(files);
    for (const file of all) {
        const code = readFileSync(file, "utf8");
        const rel = relative(projectDir, file);
        const target = join(outDir, rel);
        mkdirSync(dirname(target), { recursive: true });
        if (!toCheck.has(file) || code.indexOf("xml") === -1) {
            writeFileSync(target, code);
            continue;
        }
        const { templates, skipped } = findTemplates(code);
        skippedAll.push(...skipped.map((s) => `${rel} : ${s}`));
        if (templates.length === 0) {
            writeFileSync(target, code);
            continue;
        }
        let out = "";
        let last = 0;
        const sorted = [...templates].sort((a, b) => a.classEnd - b.classEnd);
        for (const [n, tpl] of sorted.entries()) {
            let check;
            try {
                check = generateCheck(tpl.source, tpl.className);
            } catch (error) {
                // Erreur de syntaxe dans le template : signalée directement.
                const shown = relative(cwd, file).split(sep).join("/");
                console.error(`${shown}:${tpl.line} — template "${tpl.className}" : ${(error as Error).message}`);
                templateCount++;
                mappings.push({ file: rel, generatedLine: -1, sourceLine: tpl.line, className: tpl.className });
                continue;
            }
            out += code.slice(last, tpl.classEnd);
            last = tpl.classEnd;
            // Méthode statique insérée juste avant l'accolade fermante de la classe.
            out += `\nstatic __trame_check_${n}__(): void {\n`;
            let generatedLine = out.split("\n").length;
            for (let i = 0; i < check.lines.length; i++) {
                out += check.lines[i] + "\n";
                const templateLine = check.templateLines[i];
                mappings.push({
                    file: rel,
                    generatedLine,
                    sourceLine: templateLine === undefined ? undefined : tpl.line + templateLine - 1,
                    className: tpl.className,
                });
                generatedLine++;
            }
            out += "}\n";
            templateCount++;
        }
        out += code.slice(last);
        out += "\n" + checkPrelude(trameModuleOf(code)) + "\n";
        writeFileSync(target, out);
    }

    writeFileSync(
        join(outDir, "tsconfig.json"),
        JSON.stringify({ extends: relative(outDir, projectPath).split(sep).join("/"), compilerOptions: { noEmit: true }, include: ["./**/*.ts"] }, null, 2),
    );

    // tsc du projet vérifié
    const require = createRequire(join(projectDir, "package.json"));
    let tscBin: string;
    try {
        tscBin = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    } catch {
        console.error("[trame-check] TypeScript introuvable (npm install --save-dev typescript)");
        return 2;
    }
    const result = spawnSync(process.execPath, [tscBin, "-p", join(outDir, "tsconfig.json"), "--pretty", "false"], {
        encoding: "utf8",
        cwd: projectDir,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    // Ramène les erreurs situées dans le code de vérification sur la ligne du template.
    const index = new Map<string, Mapping>();
    for (const m of mappings) {
        index.set(`${m.file}|${m.generatedLine}`, m);
    }
    const errors: string[] = [];
    const lines = output.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(lines[i]);
        if (m === null) {
            continue;
        }
        const file = relative(outDir, resolve(projectDir, m[1]));
        const mapping = index.get(`${file}|${Number(m[2])}`);
        if (mapping === undefined) {
            continue;
        }
        let message = m[5];
        while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]) && lines[i + 1].trim()) {
            message += "\n    " + lines[++i].trim();
        }
        const shown = relative(cwd, join(projectDir, mapping.file)).split(sep).join("/");
        const where = mapping.sourceLine === undefined ? shown : `${shown}:${mapping.sourceLine}`;
        errors.push(`${where} — template "${mapping.className}" : ${message} (${m[4]})`);
    }

    const unique = Array.from(new Set(errors));
    for (const e of unique) {
        console.error(e);
    }
    for (const s of skippedAll) {
        console.warn(`[trame-check] ${s}`);
    }
    const syntaxErrors = mappings.filter((m) => m.generatedLine === -1).length;
    const total = unique.length + syntaxErrors;
    console.log(`[trame-check] ${templateCount} template(s) vérifié(s), ${total} erreur(s).`);
    return total > 0 ? 1 : 0;
}

// Exécution directe (node trame-check.mjs ...)
const isMain = typeof process !== "undefined" && process.argv[1] !== undefined && /trame-check|check\.(ts|mjs|js)$/.test(process.argv[1]);
if (isMain) {
    process.exit(main(process.argv.slice(2)));
}
