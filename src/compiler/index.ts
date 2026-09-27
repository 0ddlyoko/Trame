/**
 * Compilateur de templates autonome (sans DOM) : utilisable hors du navigateur, par exemple par le
 * serveur de l'ERP qui précompile les templates au démarrage (QuickJS embarqué, Node...).
 *
 *   // Tous les fichiers de templates des modules installés, dans l'ordre des dépendances :
 *   const js = compileTemplateFiles([{ path: "sale/static/order.xml", content: "..." }, ...]);
 *   // js : module JS à servir au navigateur, qui enregistre les templates compilés.
 *
 *   // Ou un seul template :
 *   const factory = compileTemplate(xmlSource, { name: "sale.OrderForm", extensions: [ext1] });
 */

import { type CompileMode, generateCode } from "./codegen";
import { TemplateLibrary } from "./files";
import { type AST, parseTemplate } from "./parser";
import { parseXML } from "./xml";
import { applyExtension } from "./xpath";

export interface CompileOptions {
    /** Nom du template (messages d'erreur). */
    name?: string;
    /** Extensions xpath à appliquer, dans l'ordre. */
    extensions?: string[];
    /** "component" (défaut) pour un template de composant, "call" pour un template appelé par t-call. */
    mode?: CompileMode;
}

function wrap(code: string): string {
    return `(function ($h) {\n${code}\n})`;
}

/** Compile un template XML en code JS : une fabrique `(function ($h) { ... })`. */
export function compileTemplate(source: string, options: CompileOptions = {}): string {
    const name = options.name ?? "template";
    const nodes = parseXML(source);
    (options.extensions ?? []).forEach((extension, i) => {
        applyExtension(nodes, extension, name, `extension n°${i + 1}`);
    });
    return wrap(generateCode(parseTemplate(nodes), options.mode ?? "component", name));
}

export interface TemplateFile {
    /** Chemin (ou nom) du fichier : repris dans les messages d'erreur. */
    path: string;
    content: string;
}

export interface CompileFilesOptions {
    /** Module d'où importer Trame dans le code généré (défaut : "trame"). */
    module?: string;
}

/** Noms des templates appelés par t-call dans un AST. */
function calledTemplates(ast: AST, out: Set<string>): void {
    switch (ast.type) {
        case "call":
            out.add(ast.template);
            return;
        case "element":
        case "multi":
            ast.children.forEach((c) => calledTemplates(c, out));
            return;
        case "if":
            ast.branches.forEach((b) => calledTemplates(b.body, out));
            return;
        case "foreach":
        case "keyed":
            calledTemplates(ast.body, out);
            return;
        case "component":
            ast.slots.forEach((s) => calledTemplates(s.body, out));
            return;
        case "slot":
            if (ast.fallback) {
                calledTemplates(ast.fallback, out);
            }
            return;
    }
}

/**
 * Compile tous les templates de fichiers XML (dans l'ordre des dépendances des modules) et renvoie
 * un module JS qui les enregistre :
 *
 *   import { registerCompiled } from "trame";
 *   registerCompiled("sale.OrderForm", { component: (function ($h) { ... }) });
 *
 * Les templates appelés par t-call sont aussi compilés dans ce mode.
 * Une erreur (syntaxe, extension invalide...) lève une exception qui indique le fichier et la ligne.
 */
export function compileTemplateFiles(files: TemplateFile[], options: CompileFilesOptions = {}): string {
    const library = new TemplateLibrary();
    for (const file of files) {
        library.addFile(file.content, file.path);
    }
    for (const { target, origin } of library.unknownTargets()) {
        throw new Error(`[trame] ${origin} : t-inherit="${target}" vise un template qui n'est défini dans aucun fichier (module manquant ou mauvais ordre ?)`);
    }
    const asts = new Map<string, AST>();
    const called = new Set<string>();
    for (const name of library.names()) {
        const ast = parseTemplate(library.resolve(name));
        asts.set(name, ast);
        calledTemplates(ast, called);
    }
    const out = [`import { registerCompiled } from ${JSON.stringify(options.module ?? "trame")};`];
    for (const [name, ast] of asts) {
        const modes = [`component: ${wrap(generateCode(ast, "component", name))}`];
        if (called.has(name)) {
            modes.push(`call: ${wrap(generateCode(ast, "call", name))}`);
        }
        out.push(`registerCompiled(${JSON.stringify(name)}, { ${modes.join(", ")} });`);
    }
    return out.join("\n") + "\n";
}

export { TemplateLibrary };
export type { CompileMode };
