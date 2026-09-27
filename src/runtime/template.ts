/**
 * Templates : source XML, extensions (héritage par xpath), compilation paresseuse et mise en cache.
 *
 * Deux façons d'obtenir la fonction de rendu d'un template :
 * - le compiler dans le navigateur, au premier affichage (version complète, trame.js) ;
 * - l'avoir reçu déjà compilé (registerCompiled), par exemple depuis le serveur : c'est la seule
 *   possible avec trame.runtime.js, qui n'inclut pas le compilateur.
 */

import type { CompileMode } from "../compiler/codegen";
import type { XElement, XNode } from "../compiler/xml";
import type { Slots } from "./component";
import { helpers } from "./helpers";
import type { Root } from "./regions";

export type RenderFunction = (component: unknown, slots: Slots | null, params: object | null) => Root[];

/** Fabrique d'une fonction de rendu (code généré par le compilateur : `(function ($h) { ... })`). */
export type RenderFactory = (h: typeof helpers) => RenderFunction;

/** Fonctions de rendu précompilées d'un template, par mode. */
export interface CompiledTemplate {
    component?: RenderFactory;
    call?: RenderFactory;
}

/** Extension : source XML, ou opérations déjà parsées (fichiers de templates). */
export type TemplateExtension = string | XElement[];

/** Compilateur branché par la version complète de Trame (absent de trame.runtime.js). */
export interface TemplateCompiler {
    nodes(template: Template): XNode[];
    code(template: Template, mode: CompileMode): string;
    registerFile(content: string, path: string): void;
}

let compiler: TemplateCompiler | null = null;

/** Branche (ou retire, avec null) le compilateur de templates. */
export function setTemplateCompiler(value: TemplateCompiler | null): void {
    compiler = value;
}

function requireCompiler(what: string): TemplateCompiler {
    if (compiler === null) {
        throw new Error(
            `[trame] ${what} : le compilateur de templates n'est pas inclus (trame.runtime.js). ` +
                "Précompilez les templates (registerCompiled) ou utilisez trame.js.",
        );
    }
    return compiler;
}

let anonymousCount = 0;

export class Template {
    readonly extensions: TemplateExtension[] = [];
    private readonly cache = new Map<CompileMode, RenderFunction>();
    private precompiled: CompiledTemplate | null = null;
    /** Arbre fourni par un fichier de templates (registerTemplates). */
    loader: (() => XNode[]) | null = null;

    constructor(
        readonly source: string,
        public name: string = `template_${++anonymousCount}`,
        readonly base: Template | null = null,
    ) {}

    /** Ajoute une extension (xpath) : les prochains rendus utiliseront la version étendue. */
    extend(extension: TemplateExtension): void {
        this.extensions.push(extension);
        // Une version précompilée ne contient pas cette extension : il faudra recompiler.
        this.precompiled = null;
        this.cache.clear();
    }

    /** Oublie la version compilée (la source ou ses extensions ont changé). */
    invalidate(): void {
        this.cache.clear();
    }

    /** Fonctions de rendu reçues déjà compilées. */
    setCompiled(compiled: CompiledTemplate): void {
        this.precompiled = compiled;
        this.cache.clear();
    }

    /** Arbre XML final (base + extensions). Nécessite le compilateur. */
    getNodes(): XNode[] {
        return requireCompiler(`Template "${this.name}"`).nodes(this);
    }

    /** Code JS généré (débogage, précompilation). Nécessite le compilateur. */
    getCode(mode: CompileMode = "component"): string {
        return requireCompiler(`Template "${this.name}"`).code(this, mode);
    }

    getRender(mode: CompileMode): RenderFunction {
        let render = this.cache.get(mode);
        if (render === undefined) {
            let factory = this.precompiled?.[mode];
            if (factory === undefined) {
                const code = requireCompiler(`Template "${this.name}" (mode ${mode})`).code(this, mode);
                try {
                    factory = new Function("$h", code) as RenderFactory;
                } catch (e) {
                    throw new Error(`[trame] Template "${this.name}" : code généré invalide (${(e as Error).message})\n${code}`);
                }
            }
            render = factory(helpers);
            this.cache.set(mode, render);
        }
        return render;
    }
}

/**
 * Déclare un template inline :
 *   static template = xml`<div>{{ name }}</div>`;
 */
export function xml(strings: TemplateStringsArray, ...values: unknown[]): Template {
    let source = strings[0];
    for (let i = 0; i < values.length; i++) {
        source += String(values[i]) + strings[i + 1];
    }
    return new Template(source);
}

// --- Templates nommés ----------------------------------------------------------------------------

const namedTemplates = new Map<string, Template>();

/** Template nommé existant, ou créé vide s'il n'existe pas encore. */
export function namedTemplate(name: string): Template {
    let template = namedTemplates.get(name);
    if (template === undefined) {
        template = new Template("", name);
        namedTemplates.set(name, template);
    }
    return template;
}

export function hasTemplate(name: string): boolean {
    return namedTemplates.has(name);
}

/** Enregistre un template nommé (utilisable par t-call ou par `static template = "nom"`). */
export function registerTemplate(name: string, source: string | Template): Template {
    const template = typeof source === "string" ? new Template(source, name) : source;
    if (typeof source !== "string") {
        template.name = name;
    }
    namedTemplates.set(name, template);
    return template;
}

/**
 * Enregistre un template déjà compilé (par le serveur, avec compileTemplateFiles) :
 *   registerCompiled("sale.OrderForm", { component: (function ($h) { ... }) });
 */
export function registerCompiled(name: string, compiled: CompiledTemplate): Template {
    const template = namedTemplate(name);
    template.setCompiled(compiled);
    return template;
}

/**
 * Enregistre un fichier de templates (<templates> avec des <t t-name> et des <t t-inherit>),
 * compilés dans le navigateur. Nécessite le compilateur (trame.js).
 */
export function registerTemplates(content: string, path = "templates.xml"): void {
    requireCompiler(`registerTemplates("${path}")`).registerFile(content, path);
}

export function getTemplate(name: string): Template {
    const template = namedTemplates.get(name);
    if (template === undefined) {
        throw new Error(`[trame] Template "${name}" introuvable`);
    }
    return template;
}

type TemplateTarget = Template | string | { name: string; template?: Template | string };

function toTemplate(target: TemplateTarget): Template {
    if (target instanceof Template) {
        return target;
    }
    if (typeof target === "string") {
        return getTemplate(target);
    }
    return resolveTemplate(target);
}

/**
 * Étend un template existant (mode « extension ») : toutes ses utilisations voient la modification.
 * L'extension contient des <xpath expr="..." position="..."> (ou des éléments avec position="...").
 */
export function extendTemplate(target: TemplateTarget, extension: string): void {
    toTemplate(target).extend(extension);
}

/** Crée un nouveau template à partir d'un autre (mode « primaire »), sans modifier l'original. */
export function inheritTemplate(base: TemplateTarget, extension: string, name?: string): Template {
    return new Template(extension, name, toTemplate(base));
}

/** Template d'une classe de composant. */
export function resolveTemplate(Ctor: { name: string; template?: Template | string }): Template {
    const template = Ctor.template;
    if (template === undefined) {
        throw new Error(`[trame] Le composant ${Ctor.name} n'a pas de template (static template = xml\`...\`)`);
    }
    if (typeof template === "string") {
        return getTemplate(template);
    }
    if (template.name.startsWith("template_")) {
        template.name = Ctor.name || template.name;
    }
    return template;
}
