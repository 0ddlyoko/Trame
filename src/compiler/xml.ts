/**
 * Petit parseur XML, sans dépendance au DOM (utilisable aussi côté serveur pour précompiler).
 * Il produit un arbre simple, manipulable par l'héritage de templates (xpath).
 */

export interface XAttr {
    name: string;
    value: string;
}

/** Position d'un nœud dans sa source (messages d'erreur). */
export interface XPosition {
    /** Ligne (à partir de 1) dans la source du template ou de l'extension. */
    line?: number;
    /** Source d'origine quand ce n'est pas le template lui-même (ex. une extension). */
    origin?: string;
}

export interface XElement extends XPosition {
    type: "element";
    tag: string;
    attrs: XAttr[];
    children: XNode[];
    parent: XElement | null;
}

export interface XText extends XPosition {
    type: "text";
    value: string;
    parent: XElement | null;
}

export type XNode = XElement | XText;

export class TemplateSyntaxError extends Error {
    constructor(message: string, source: string, index: number) {
        const before = source.slice(0, index);
        const line = before.split("\n").length;
        const column = index - before.lastIndexOf("\n");
        super(`${message} (ligne ${line}, colonne ${column})`);
        this.name = "TemplateSyntaxError";
    }
}

const NAMED_ENTITIES: Record<string, string> = {
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'",
    nbsp: " ",
    copy: "©",
    reg: "®",
    euro: "€",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    laquo: "«",
    raquo: "»",
    times: "×",
    middot: "·",
    bull: "•",
    deg: "°",
};

export function decodeEntities(text: string): string {
    if (text.indexOf("&") === -1) {
        return text;
    }
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity: string) => {
        if (entity[0] === "#") {
            const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            return String.fromCodePoint(code);
        }
        const value = NAMED_ENTITIES[entity];
        return value === undefined ? match : value;
    });
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[\w:.\-@]/;

/** Parse une chaîne XML (plusieurs racines autorisées) en liste de nœuds. */
export function parseXML(source: string, origin?: string): XNode[] {
    const roots: XNode[] = [];
    const stack: XElement[] = [];
    let i = 0;
    const n = source.length;

    // Numéro de ligne d'une position (calcul incrémental : les positions demandées sont croissantes).
    let lineIndex = 0;
    let line = 1;
    const lineAt = (index: number): number => {
        for (; lineIndex < index; lineIndex++) {
            if (source.charCodeAt(lineIndex) === 10) {
                line++;
            }
        }
        return line;
    };

    const current = (): XNode[] => (stack.length ? stack[stack.length - 1].children : roots);
    const parentEl = (): XElement | null => (stack.length ? stack[stack.length - 1] : null);
    const fail = (message: string, at = i): never => {
        throw new TemplateSyntaxError(message, source, at);
    };

    const pushText = (raw: string): void => {
        if (raw.length === 0) {
            return;
        }
        const list = current();
        const last = list[list.length - 1];
        const value = decodeEntities(raw);
        if (last !== undefined && last.type === "text") {
            last.value += value;
        } else {
            list.push({ type: "text", value, parent: parentEl(), line: lineAt(i), origin });
        }
    };

    const readName = (): string => {
        const start = i;
        if (i >= n || !NAME_START.test(source[i])) {
            fail("Nom attendu");
        }
        i++;
        while (i < n && NAME_CHAR.test(source[i])) {
            i++;
        }
        return source.slice(start, i);
    };

    const skipSpaces = (): void => {
        while (i < n && /\s/.test(source[i])) {
            i++;
        }
    };

    while (i < n) {
        const lt = source.indexOf("<", i);
        if (lt === -1) {
            pushText(source.slice(i));
            break;
        }
        pushText(source.slice(i, lt));
        i = lt;
        if (source.startsWith("<!--", i)) {
            const end = source.indexOf("-->", i + 4);
            if (end === -1) {
                fail("Commentaire non fermé");
            }
            i = end + 3;
            continue;
        }
        if (source.startsWith("<![CDATA[", i)) {
            const end = source.indexOf("]]>", i + 9);
            if (end === -1) {
                fail("CDATA non fermé");
            }
            const list = current();
            list.push({ type: "text", value: source.slice(i + 9, end), parent: parentEl() });
            i = end + 3;
            continue;
        }
        if (source.startsWith("<?", i)) {
            const end = source.indexOf("?>", i + 2);
            if (end === -1) {
                fail("Instruction de traitement non fermée");
            }
            i = end + 2;
            continue;
        }
        if (source.startsWith("<!", i)) {
            const end = source.indexOf(">", i + 2);
            i = end === -1 ? n : end + 1;
            continue;
        }
        if (source[i + 1] === "/") {
            // Balise fermante
            const start = i;
            i += 2;
            const tag = readName();
            skipSpaces();
            if (source[i] !== ">") {
                fail(`">" attendu pour fermer </${tag}>`);
            }
            i++;
            const open = stack.pop();
            if (open === undefined) {
                fail(`Balise fermante </${tag}> sans balise ouvrante`, start);
            } else if (open.tag !== tag) {
                fail(`Balise fermante </${tag}> inattendue : <${open.tag}> est encore ouverte`, start);
            }
            continue;
        }
        // Balise ouvrante
        i++;
        const tag = readName();
        const el: XElement = { type: "element", tag, attrs: [], children: [], parent: parentEl(), line: lineAt(i), origin };
        for (;;) {
            skipSpaces();
            if (i >= n) {
                fail(`Balise <${tag}> non terminée`);
            }
            const c = source[i];
            if (c === "/") {
                if (source[i + 1] !== ">") {
                    fail('"/>" attendu');
                }
                i += 2;
                current().push(el);
                break;
            }
            if (c === ">") {
                i++;
                current().push(el);
                stack.push(el);
                break;
            }
            const attrStart = i;
            const name = readName();
            skipSpaces();
            let value = "";
            if (source[i] === "=") {
                i++;
                skipSpaces();
                const quote = source[i];
                if (quote !== '"' && quote !== "'") {
                    fail(`Valeur de l'attribut "${name}" : guillemets attendus`);
                }
                const end = source.indexOf(quote, i + 1);
                if (end === -1) {
                    fail(`Valeur de l'attribut "${name}" non fermée`);
                }
                value = decodeEntities(source.slice(i + 1, end));
                i = end + 1;
            }
            if (el.attrs.some((a) => a.name === name)) {
                fail(`Attribut "${name}" en double`, attrStart);
            }
            el.attrs.push({ name, value });
        }
    }
    if (stack.length) {
        const open = stack[stack.length - 1];
        throw new TemplateSyntaxError(`Balise <${open.tag}> non fermée`, source, n);
    }
    return roots;
}

// --- Utilitaires sur l'arbre ---------------------------------------------------------------------

export function getAttr(el: XElement, name: string): string | undefined {
    for (const attr of el.attrs) {
        if (attr.name === name) {
            return attr.value;
        }
    }
    return undefined;
}

export function hasAttr(el: XElement, name: string): boolean {
    return getAttr(el, name) !== undefined;
}

export function setAttr(el: XElement, name: string, value: string): void {
    for (const attr of el.attrs) {
        if (attr.name === name) {
            attr.value = value;
            return;
        }
    }
    el.attrs.push({ name, value });
}

export function removeAttr(el: XElement, name: string): void {
    const index = el.attrs.findIndex((a) => a.name === name);
    if (index !== -1) {
        el.attrs.splice(index, 1);
    }
}

export function cloneNode<T extends XNode>(node: T, parent: XElement | null = null): T {
    if (node.type === "text") {
        return { type: "text", value: node.value, parent, line: node.line, origin: node.origin } as T;
    }
    const el: XElement = {
        type: "element",
        tag: node.tag,
        attrs: node.attrs.map((a) => ({ ...a })),
        children: [],
        parent,
        line: node.line,
        origin: node.origin,
    };
    el.children = node.children.map((c) => cloneNode(c, el));
    return el as T;
}

/** Resérialise un arbre (utile pour les messages d'erreur et le débogage). */
export function serialize(nodes: XNode[]): string {
    let out = "";
    for (const node of nodes) {
        if (node.type === "text") {
            out += node.value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        } else {
            out += `<${node.tag}`;
            for (const a of node.attrs) {
                out += ` ${a.name}="${a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
            }
            out += node.children.length ? `>${serialize(node.children)}</${node.tag}>` : "/>";
        }
    }
    return out;
}
