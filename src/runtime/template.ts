/**
 * Templates : source XML, extensions (héritage par xpath), compilation paresseuse et mise en cache.
 */

import { type CompileMode, generateCode } from "../compiler/codegen";
import { parseTemplate } from "../compiler/parser";
import { parseXML, type XNode } from "../compiler/xml";
import { applyExtension } from "../compiler/xpath";
import type { Slots } from "./component";
import { helpers } from "./helpers";
import type { Root } from "./regions";

export type RenderFunction = (component: unknown, slots: Slots | null, params: object | null) => Root[];

let anonymousCount = 0;

export class Template {
    private readonly extensions: string[] = [];
    private readonly cache = new Map<CompileMode, RenderFunction>();

    constructor(
        readonly source: string,
        public name: string = `template_${++anonymousCount}`,
        private readonly base: Template | null = null,
    ) {}

    /** Ajoute une extension (xpath) : les prochains rendus utiliseront la version étendue. */
    extend(extension: string): void {
        this.extensions.push(extension);
        this.cache.clear();
    }

    /** Arbre XML final (base + extensions). */
    getNodes(): XNode[] {
        const nodes = this.base ? this.base.getNodes() : parseXML(this.source);
        if (this.base) {
            // Héritage « primaire » : la source est elle-même une extension de la base.
            applyExtension(nodes, this.source, this.name, `héritage de "${this.base.name}"`);
        }
        this.extensions.forEach((extension, i) => {
            applyExtension(nodes, extension, this.name, `extension n°${i + 1}`);
        });
        return nodes;
    }

    /** Code JS généré (utile pour le débogage ou la précompilation). */
    getCode(mode: CompileMode = "component"): string {
        return generateCode(parseTemplate(this.getNodes()), mode, this.name);
    }

    getRender(mode: CompileMode): RenderFunction {
        let render = this.cache.get(mode);
        if (render === undefined) {
            const code = this.getCode(mode);
            let factory: (h: typeof helpers) => RenderFunction;
            try {
                factory = new Function("$h", code) as (h: typeof helpers) => RenderFunction;
            } catch (e) {
                throw new Error(`[trame] Template "${this.name}" : code généré invalide (${(e as Error).message})\n${code}`);
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

/** Enregistre un template nommé (utilisable par t-call ou par `static template = "nom"`). */
export function registerTemplate(name: string, source: string | Template): Template {
    const template = typeof source === "string" ? new Template(source, name) : source;
    if (typeof source !== "string") {
        template.name = name;
    }
    namedTemplates.set(name, template);
    return template;
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
