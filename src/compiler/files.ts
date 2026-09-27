/**
 * Fichiers de templates (façon Odoo), un ou plusieurs par module :
 *
 *   <templates>
 *       <t t-name="sale.OrderForm">                       nouveau template
 *           <div class="o-order">...</div>
 *       </t>
 *
 *       <t t-inherit="web.Card">                           extension d'un template existant
 *           <xpath expr="//h1" position="after">...</xpath>
 *       </t>
 *
 *       <t t-name="sale.SpecialForm" t-inherit="sale.OrderForm">   nouveau template dérivé
 *           <xpath expr="//h1" position="replace"><h2>...</h2></xpath>
 *       </t>
 *   </templates>
 *
 * Les fichiers sont ajoutés dans l'ordre des dépendances des modules : les extensions s'appliquent
 * dans cet ordre. Les nœuds gardent leur fichier et leur ligne d'origine (messages d'erreur).
 */

import { getAttr, parseXML, type XElement, type XNode } from "./xml";
import { applyOperations, extensionOperations } from "./xpath";

interface Definition {
    name: string;
    origin: string;
    /** Contenu (template simple). */
    nodes: XNode[] | null;
    /** Héritage « primaire » : template de base + opérations. */
    base: string | null;
    ops: XElement[];
}

interface Extension {
    target: string;
    origin: string;
    ops: XElement[];
}

function copy(nodes: XNode[], parent: XElement | null = null): XNode[] {
    return nodes.map((node) => {
        if (node.type === "text") {
            return { ...node, parent };
        }
        const el: XElement = { ...node, attrs: node.attrs.map((a) => ({ ...a })), children: [], parent };
        el.children = copy(node.children, el);
        return el;
    });
}

export class TemplateLibrary {
    private readonly definitions = new Map<string, Definition>();
    private readonly extensions: Extension[] = [];

    /** Ajoute un fichier de templates. Renvoie les noms définis et les extensions du fichier. */
    addFile(content: string, path: string): { defined: string[]; extensions: { target: string; ops: XElement[] }[] } {
        const defined: string[] = [];
        const extensions: { target: string; ops: XElement[] }[] = [];
        const visit = (nodes: XNode[]) => {
            for (const node of nodes) {
                if (node.type === "text") {
                    if (node.value.trim()) {
                        throw new Error(`[trame] ${path}, ligne ${node.line} : texte inattendu hors d'un <t t-name> ou <t t-inherit>`);
                    }
                    continue;
                }
                if (node.tag === "templates") {
                    visit(node.children);
                    continue;
                }
                const name = getAttr(node, "t-name");
                const inherit = getAttr(node, "t-inherit");
                if (node.tag !== "t" || (name === undefined && inherit === undefined)) {
                    throw new Error(`[trame] ${path}, ligne ${node.line} : <${node.tag}> inattendu, <t t-name="..."> ou <t t-inherit="..."> attendu`);
                }
                if (name !== undefined) {
                    if (this.definitions.has(name)) {
                        throw new Error(`[trame] ${path}, ligne ${node.line} : le template "${name}" est déjà défini (${this.definitions.get(name)!.origin})`);
                    }
                    this.definitions.set(name, {
                        name,
                        origin: path,
                        nodes: inherit === undefined ? node.children : null,
                        base: inherit ?? null,
                        ops: inherit === undefined ? [] : extensionOperations(node.children),
                    });
                    defined.push(name);
                } else {
                    const ext = { target: inherit!, origin: path, ops: extensionOperations(node.children) };
                    this.extensions.push(ext);
                    extensions.push(ext);
                }
            }
        };
        visit(parseXML(content, path));
        return { defined, extensions };
    }

    /** Extensions dont la cible n'est définie dans aucun fichier. */
    unknownTargets(): { target: string; origin: string }[] {
        return this.extensions.filter((e) => !this.definitions.has(e.target)).map(({ target, origin }) => ({ target, origin }));
    }

    has(name: string): boolean {
        return this.definitions.has(name);
    }

    names(): string[] {
        return Array.from(this.definitions.keys());
    }

    /** Arbre final d'un template (base, héritage primaire, extensions), recalculé à chaque appel. */
    resolve(name: string, seen: string[] = []): XNode[] {
        const def = this.definitions.get(name);
        if (def === undefined) {
            throw new Error(`[trame] Template "${name}" introuvable`);
        }
        if (seen.includes(name)) {
            throw new Error(`[trame] Héritage circulaire : ${[...seen, name].join(" → ")}`);
        }
        let nodes: XNode[];
        if (def.base !== null) {
            nodes = this.resolve(def.base, [...seen, name]);
            applyOperations(nodes, def.ops, name);
        } else {
            nodes = copy(def.nodes!);
        }
        for (const ext of this.extensions) {
            if (ext.target === name) {
                applyOperations(nodes, ext.ops, name);
            }
        }
        return nodes;
    }
}
