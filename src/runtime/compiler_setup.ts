/**
 * Branche le compilateur de templates (version complète de Trame, trame.js).
 * trame.runtime.js n'importe pas ce module : les templates doivent alors être précompilés.
 */

import { generateCode } from "../compiler/codegen";
import { TemplateLibrary } from "../compiler/files";
import { parseTemplate } from "../compiler/parser";
import { parseXML, type XNode } from "../compiler/xml";
import { applyExtension, applyOperations } from "../compiler/xpath";
import { getTemplate, hasTemplate, namedTemplate, setTemplateCompiler, type Template, type TemplateCompiler } from "./template";

/** Templates venant de fichiers XML (registerTemplates). */
const library = new TemplateLibrary();
const libraryTemplates = new Set<Template>();

export const templateCompiler: TemplateCompiler = {
    nodes(template: Template): XNode[] {
        let nodes: XNode[];
        if (template.loader !== null) {
            nodes = template.loader();
        } else if (template.base !== null) {
            nodes = templateCompiler.nodes(template.base);
            // Héritage « primaire » : la source est elle-même une extension de la base.
            applyExtension(nodes, template.source, template.name, `héritage de "${template.base.name}"`);
        } else {
            nodes = parseXML(template.source);
        }
        template.extensions.forEach((extension, i) => {
            if (typeof extension === "string") {
                applyExtension(nodes, extension, template.name, `extension n°${i + 1}`);
            } else {
                applyOperations(nodes, extension, template.name);
            }
        });
        return nodes;
    },

    code(template: Template, mode) {
        return generateCode(parseTemplate(templateCompiler.nodes(template)), mode, template.name);
    },

    registerFile(content: string, path: string): void {
        const { defined, extensions } = library.addFile(content, path);
        for (const name of defined) {
            const template = namedTemplate(name);
            template.loader = () => library.resolve(name);
            libraryTemplates.add(template);
        }
        for (const { target, ops } of extensions) {
            if (library.has(target)) {
                continue; // appliquée par la bibliothèque lors de la résolution
            }
            if (!hasTemplate(target)) {
                throw new Error(`[trame] ${path} : t-inherit="${target}" vise un template inconnu (fichiers chargés dans le bon ordre ?)`);
            }
            getTemplate(target).extend(ops);
        }
        // Une extension peut modifier un template déjà compilé, ou la base d'un template dérivé.
        for (const template of libraryTemplates) {
            template.invalidate();
        }
    },
};

setTemplateCompiler(templateCompiler);
