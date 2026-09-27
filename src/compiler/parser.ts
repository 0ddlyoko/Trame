/**
 * Transforme l'arbre XML d'un template en AST, en interprétant les directives t-*.
 *
 * Directives :
 *   t-if / t-elif / t-else          conditions (sur des éléments frères consécutifs)
 *   t-foreach + t-as [+ t-key]      boucle (t-key fortement recommandé)
 *   t-set + t-value                 variable locale (réactive)
 *   t-out                           insère une valeur (texte échappé, ou markup(...) pour du HTML)
 *   t-att-NAME / t-att              attributs dynamiques
 *   NAME="... {{ expr }} ..."       interpolation dans un attribut
 *   {{ expr }}                      interpolation dans le texte
 *   t-on-EVENT[.modificateurs]      événements
 *   t-ref                           référence vers l'élément
 *   t-component                     composant dynamique
 *   t-props                         props passées en bloc à un composant
 *   t-slot [+ attributs]            (dans un composant) affiche un slot reçu, avec contenu par défaut
 *   t-set-slot [+ t-slot-scope]     (dans l'appel d'un composant) définit un slot nommé
 *   t-call                          appelle un template nommé
 *   t-key (hors t-foreach)          recrée l'élément / le composant quand la valeur change
 */

import { isIdentifier } from "./expression";
import { getAttr, TemplateSyntaxError, type XElement, type XNode, type XPosition } from "./xml";

export type Namespace = "html" | "svg" | "math";

/** Position dans la source (ligne, origine) : utilisée pour localiser les erreurs. */
export type Pos = XPosition;

export interface TextPart {
    /** Texte statique ou expression. */
    text?: string;
    expr?: string;
}

export interface ASTText {
    type: "text";
    value: string;
    /** Ne pas traduire (t-translation="off"). */
    raw?: boolean;
}

export interface ASTTextExpr {
    type: "textExpr";
    parts: TextPart[];
    pos?: Pos;
}

export interface ASTAttrExpr {
    name: string;
    /** Expression (t-att-x) ou morceaux interpolés (x="a {{ b }}"). */
    expr?: string;
    parts?: TextPart[];
}

export interface ASTEvent {
    name: string;
    modifiers: string[];
    expr: string;
}

export interface ASTElement {
    type: "element";
    tag: string;
    ns: Namespace;
    attrs: [string, string][];
    dynAttrs: ASTAttrExpr[];
    attrsSpread?: string;
    events: ASTEvent[];
    ref?: string;
    children: AST[];
    /** Ne pas traduire les attributs (t-translation="off"). */
    noTranslate?: boolean;
    pos?: Pos;
}

export interface ASTMulti {
    type: "multi";
    children: AST[];
}

export interface ASTIf {
    type: "if";
    branches: { cond: string | null; body: AST }[];
    pos?: Pos;
}

export interface ASTForEach {
    type: "foreach";
    collection: string;
    as: string;
    key: string | null;
    body: AST;
    pos?: Pos;
}

export interface ASTSet {
    type: "set";
    name: string;
    value: string;
    pos?: Pos;
}

export interface ASTOut {
    type: "out";
    expr: string;
    pos?: Pos;
}

export interface ASTSlotDef {
    name: string;
    scope: string | null;
    body: AST;
}

export interface ASTComponent {
    type: "component";
    name: string | null;
    dynamic: string | null;
    props: { name: string; expr?: string; parts?: TextPart[] }[];
    spread: string | null;
    slots: ASTSlotDef[];
    pos?: Pos;
}

export interface ASTSlot {
    type: "slot";
    name: string;
    params: { name: string; expr: string }[];
    fallback: AST | null;
    pos?: Pos;
}

/** t-key hors d'une boucle : le contenu est recréé quand la clé change. */
export interface ASTKeyed {
    type: "keyed";
    key: string;
    body: AST;
    pos?: Pos;
}

export interface ASTCall {
    type: "call";
    template: string;
    params: { name: string; expr: string }[];
    pos?: Pos;
}

export type AST =
    | ASTText
    | ASTTextExpr
    | ASTElement
    | ASTMulti
    | ASTIf
    | ASTForEach
    | ASTSet
    | ASTOut
    | ASTComponent
    | ASTSlot
    | ASTCall
    | ASTKeyed;

/** Composants fournis par Trame, utilisables sans les déclarer dans `static components`. */
export const BUILTIN_COMPONENTS = new Set(["Suspense", "ErrorBoundary", "ErrorHandler", "Portal"]);

const KNOWN_DIRECTIVES = new Set([
    "t-if",
    "t-elif",
    "t-else",
    "t-foreach",
    "t-as",
    "t-key",
    "t-set",
    "t-value",
    "t-out",
    "t-att",
    "t-ref",
    "t-component",
    "t-props",
    "t-slot",
    "t-set-slot",
    "t-slot-scope",
    "t-call",
    "t-name",
    "t-translation",
]);

/** Directives traitées ailleurs que dans la boucle des attributs d'un élément. */
const HANDLED_ELSEWHERE = new Set(["t-key", "t-if", "t-elif", "t-else", "t-out", "t-as", "t-foreach", "t-set-slot", "t-slot-scope", "t-translation"]);

/** Éléments dont le contenu texte est conservé tel quel. */
const PRESERVE_WHITESPACE = new Set(["pre", "textarea"]);

export function parseTemplate(nodes: XNode[]): AST {
    const ctx = new ParseContext();
    const children = ctx.parseChildren(nodes, "html", false);
    return children.length === 1 ? children[0] : { type: "multi", children };
}

/** Découpe « texte {{ expr }} texte » en morceaux. */
export function splitInterpolation(text: string): TextPart[] | null {
    if (text.indexOf("{{") === -1) {
        return null;
    }
    const parts: TextPart[] = [];
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf("{{", i);
        if (start === -1) {
            parts.push({ text: text.slice(i) });
            break;
        }
        if (start > i) {
            parts.push({ text: text.slice(i, start) });
        }
        const end = text.indexOf("}}", start + 2);
        if (end === -1) {
            throw new Error(`[trame] "{{" sans "}}" correspondant dans « ${text} »`);
        }
        const expr = text.slice(start + 2, end).trim();
        if (expr) {
            parts.push({ expr });
        }
        i = end + 2;
    }
    return parts;
}

class ParseContext {
    /** À l'intérieur d'un t-translation="off". */
    private noTranslate = false;

    parseChildren(nodes: XNode[], ns: Namespace, preserve: boolean): AST[] {
        const result: AST[] = [];
        let i = 0;
        while (i < nodes.length) {
            const node = nodes[i];
            if (node.type === "text") {
                const ast = this.parseText(node.value, preserve, pos(node));
                if (ast) {
                    result.push(ast);
                }
                i++;
                continue;
            }
            if (getAttr(node, "t-elif") !== undefined || getAttr(node, "t-else") !== undefined) {
                throw new Error(`[trame] <${node.tag}> : t-elif/t-else doit suivre directement un élément t-if ou t-elif`);
            }
            if (getAttr(node, "t-if") !== undefined && getAttr(node, "t-foreach") === undefined) {
                // Chaîne t-if / t-elif / t-else sur les frères suivants (en ignorant les blancs)
                const branches: ASTIf["branches"] = [
                    { cond: getAttr(node, "t-if")!, body: this.parseElement(node, ns, preserve, ["t-if"]) },
                ];
                let j = i + 1;
                for (;;) {
                    let k = j;
                    while (k < nodes.length && nodes[k].type === "text" && !(nodes[k] as { value: string }).value.trim()) {
                        k++;
                    }
                    const next = nodes[k];
                    if (next === undefined || next.type !== "element") {
                        break;
                    }
                    const elif = getAttr(next, "t-elif");
                    const isElse = getAttr(next, "t-else") !== undefined;
                    if (elif === undefined && !isElse) {
                        break;
                    }
                    branches.push({
                        cond: isElse ? null : elif!,
                        body: this.parseElement(next, ns, preserve, ["t-elif", "t-else"]),
                    });
                    j = k + 1;
                    if (isElse) {
                        break;
                    }
                }
                result.push({ type: "if", branches, pos: pos(node) });
                i = j;
                continue;
            }
            result.push(this.parseElement(node, ns, preserve, []));
            i++;
        }
        return result;
    }

    parseText(value: string, preserve: boolean, position?: Pos): AST | null {
        let text = value;
        if (!preserve) {
            if (!text.trim() && text.indexOf("\n") !== -1) {
                return null;
            }
            // Les blancs contenant un retour à la ligne (indentation) sont réduits à un espace.
            text = text.replace(/\s*\n\s*/g, " ");
        }
        const parts = splitInterpolation(text);
        if (parts === null) {
            return text ? { type: "text", value: text, raw: this.noTranslate || undefined } : null;
        }
        // Ligne de la première interpolation (le texte peut commencer plus haut).
        const before = value.slice(0, value.indexOf("{{"));
        const line = position?.line !== undefined ? position.line + (before.match(/\n/g)?.length ?? 0) : undefined;
        return { type: "textExpr", parts, pos: { line, origin: position?.origin } };
    }

    parseElement(el: XElement, ns: Namespace, preserve: boolean, handled: string[]): AST {
        if (getAttr(el, "t-translation") === "off" && !this.noTranslate) {
            this.noTranslate = true;
            try {
                return this.parseElementInner(el, ns, preserve, handled);
            } finally {
                this.noTranslate = false;
            }
        }
        return this.parseElementInner(el, ns, preserve, handled);
    }

    private parseElementInner(el: XElement, ns: Namespace, preserve: boolean, handled: string[]): AST {
        const attr = (name: string): string | undefined => (handled.includes(name) ? undefined : getAttr(el, name));

        for (const { name } of el.attrs) {
            if (
                name.startsWith("t-") &&
                !KNOWN_DIRECTIVES.has(name) &&
                !name.startsWith("t-att-") &&
                !name.startsWith("t-on-")
            ) {
                throw new Error(`[trame] Directive inconnue "${name}" sur <${el.tag}>`);
            }
        }

        // t-foreach enveloppe tout le reste (y compris un éventuel t-if, évalué pour chaque élément)
        const collection = attr("t-foreach");
        if (collection !== undefined) {
            const as = getAttr(el, "t-as");
            if (as === undefined || !isIdentifier(as)) {
                throw new Error(`[trame] t-foreach="${collection}" : t-as doit être un nom de variable valide`);
            }
            const key = getAttr(el, "t-key") ?? null;
            const inner = this.parseElement(el, ns, preserve, [...handled, "t-foreach", "t-as", "t-key"]);
            let body = inner;
            const cond = getAttr(el, "t-if");
            if (cond !== undefined && !handled.includes("t-if")) {
                body = {
                    type: "if",
                    branches: [{ cond, body: this.parseElement(el, ns, preserve, [...handled, "t-foreach", "t-as", "t-key", "t-if"]) }],
                    pos: pos(el),
                };
            }
            return { type: "foreach", collection, as, key, body, pos: pos(el) };
        }

        // t-key hors d'une boucle : recréation du contenu quand la clé change
        const key = attr("t-key");
        if (key !== undefined) {
            return { type: "keyed", key, body: this.parseElement(el, ns, preserve, [...handled, "t-key"]), pos: pos(el) };
        }

        const set = attr("t-set");
        if (set !== undefined) {
            if (!isIdentifier(set)) {
                throw new Error(`[trame] t-set="${set}" : nom de variable invalide`);
            }
            const value = getAttr(el, "t-value");
            if (value === undefined) {
                throw new Error(`[trame] t-set="${set}" : t-value est obligatoire`);
            }
            return { type: "set", name: set, value, pos: pos(el) };
        }

        const call = attr("t-call");
        if (call !== undefined) {
            return { type: "call", template: call, params: this.plainParams(el, ["t-call"]), pos: pos(el) };
        }

        const slot = attr("t-slot");
        if (slot !== undefined) {
            const fallbackChildren = this.parseChildren(el.children, ns, preserve);
            return {
                type: "slot",
                name: slot || "default",
                params: this.plainParams(el, ["t-slot"]),
                fallback: fallbackChildren.length ? toSingle(fallbackChildren) : null,
                pos: pos(el),
            };
        }

        const dynamicComponent = attr("t-component");
        const isComponent = dynamicComponent !== undefined || /^[A-Z]/.test(el.tag) || BUILTIN_COMPONENTS.has(el.tag);
        if (isComponent) {
            return this.parseComponent(el, dynamicComponent ?? null, ns, preserve);
        }

        const out = attr("t-out");

        if (el.tag === "t") {
            if (out !== undefined) {
                return { type: "out", expr: out, pos: pos(el) };
            }
            const children = this.parseChildren(el.children, ns, preserve);
            return toSingle(children);
        }

        // Élément HTML/SVG
        const childNs: Namespace = el.tag === "svg" ? "svg" : el.tag === "math" ? "math" : el.tag === "foreignObject" ? "html" : ns;
        const elementNs: Namespace = el.tag === "svg" ? "svg" : el.tag === "math" ? "math" : ns;
        const node: ASTElement = {
            type: "element",
            tag: el.tag,
            ns: elementNs,
            attrs: [],
            dynAttrs: [],
            events: [],
            children: [],
            noTranslate: this.noTranslate || undefined,
            pos: pos(el),
        };
        for (const { name, value } of el.attrs) {
            if (name === "t-ref") {
                node.ref = value;
            } else if (name === "t-att") {
                node.attrsSpread = value;
            } else if (name.startsWith("t-att-")) {
                node.dynAttrs.push({ name: name.slice(6), expr: value });
            } else if (name.startsWith("t-on-")) {
                const [event, ...modifiers] = name.slice(5).split(".");
                if (!event) {
                    throw new Error(`[trame] <${el.tag}> : nom d'événement manquant dans "${name}"`);
                }
                node.events.push({ name: event, modifiers, expr: value });
            } else if (name.startsWith("t-")) {
                // directive déjà traitée (t-if, t-key...) ou sans effet sur un élément
                if (HANDLED_ELSEWHERE.has(name)) {
                    continue;
                }
                throw new Error(`[trame] La directive "${name}" n'est pas utilisable sur <${el.tag}>`);
            } else {
                const parts = splitInterpolation(value);
                if (parts === null) {
                    node.attrs.push([name, value]);
                } else {
                    node.dynAttrs.push({ name, parts });
                }
            }
        }
        const keepSpaces = preserve || PRESERVE_WHITESPACE.has(el.tag);
        if (out !== undefined) {
            node.children = [{ type: "out", expr: out, pos: pos(el) }];
        } else {
            node.children = this.parseChildren(el.children, childNs, keepSpaces);
        }
        return node;
    }

    parseComponent(el: XElement, dynamic: string | null, ns: Namespace, preserve: boolean): ASTComponent {
        const node: ASTComponent = {
            type: "component",
            name: dynamic === null ? el.tag : null,
            dynamic,
            props: [],
            spread: null,
            slots: [],
            pos: pos(el),
        };
        for (const { name, value } of el.attrs) {
            if (name === "t-props") {
                node.spread = value;
            } else if (name === "t-component" || name === "t-slot-scope" || HANDLED_ELSEWHERE.has(name)) {
                continue;
            } else if (name.startsWith("t-")) {
                throw new Error(`[trame] La directive "${name}" n'est pas utilisable sur le composant <${el.tag}>`);
            } else {
                const parts = splitInterpolation(value);
                if (parts !== null && !(parts.length === 1 && parts[0].expr !== undefined && value.trim().startsWith("{{"))) {
                    node.props.push({ name, parts });
                } else if (parts !== null) {
                    node.props.push({ name, expr: parts[0].expr });
                } else {
                    node.props.push({ name, expr: value });
                }
            }
        }
        // Slots : t-set-slot nommés, le reste forme le slot "default"
        const defaultChildren: XNode[] = [];
        for (const child of el.children) {
            if (child.type === "element" && getAttr(child, "t-set-slot") !== undefined) {
                const slotName = getAttr(child, "t-set-slot")!;
                const scope = getAttr(child, "t-slot-scope") ?? null;
                if (scope !== null && !isIdentifier(scope)) {
                    throw new Error(`[trame] t-slot-scope="${scope}" : nom de variable invalide`);
                }
                const inner =
                    child.tag === "t"
                        ? toSingle(this.parseChildren(child.children, ns, preserve))
                        : this.parseElement(child, ns, preserve, ["t-set-slot", "t-slot-scope"]);
                node.slots.push({ name: slotName, scope, body: inner });
            } else {
                defaultChildren.push(child);
            }
        }
        const defaultBody = this.parseChildren(defaultChildren, ns, preserve);
        if (defaultBody.length && !node.slots.some((s) => s.name === "default")) {
            const scope = getAttr(el, "t-slot-scope") ?? null;
            node.slots.push({ name: "default", scope, body: toSingle(defaultBody) });
        }
        return node;
    }

    /** Attributs d'un t-call / t-slot : paramètres (expressions). */
    plainParams(el: XElement, skip: string[]): { name: string; expr: string }[] {
        const params: { name: string; expr: string }[] = [];
        for (const { name, value } of el.attrs) {
            if (skip.includes(name) || name.startsWith("t-")) {
                continue;
            }
            if (!isIdentifier(name)) {
                throw new Error(`[trame] Paramètre invalide "${name}" sur <${el.tag}>`);
            }
            params.push({ name, expr: value });
        }
        return params;
    }
}

function pos(node: XPosition): Pos {
    return { line: node.line, origin: node.origin };
}

function toSingle(children: AST[]): AST {
    return children.length === 1 ? children[0] : { type: "multi", children };
}

export { TemplateSyntaxError };
