/**
 * Héritage de templates (façon Odoo) : une extension modifie l'arbre XML d'un template avant compilation.
 *
 *   <t>
 *     <xpath expr="//h1" position="after"><p>Ajouté</p></xpath>
 *     <xpath expr="//table" position="attributes">
 *       <attribute name="class" add="big" remove="small"/>
 *       <attribute name="title">Lignes</attribute>
 *     </xpath>
 *     <div name="footer" position="inside">...</div>   (raccourci : premier <div name="footer">)
 *   </t>
 *
 * Positions : inside (à la fin), before, after, replace (le texte « $0 » réinsère l'élément d'origine),
 * attributes.
 *
 * Sous-ensemble xpath supporté : /a/b, //a, *, ., .., prédicats [n], [@attr], [@attr='v'],
 * [hasclass('x')], [contains(@attr, 'v')], combinés avec « and ».
 */

import { cloneNode, getAttr, parseXML, removeAttr, setAttr, type XElement, type XNode } from "./xml";

export function applyExtension(nodes: XNode[], extension: string, templateName: string, origin = "extension"): void {
    const root: XElement = { type: "element", tag: "#root", attrs: [], children: nodes, parent: null };
    for (const node of nodes) {
        node.parent = root;
    }
    const ops: XElement[] = [];
    for (const node of parseXML(extension, origin)) {
        if (node.type !== "element") {
            continue;
        }
        if (node.tag === "t" && getAttr(node, "position") === undefined) {
            for (const child of node.children) {
                if (child.type === "element") {
                    ops.push(child);
                }
            }
        } else {
            ops.push(node);
        }
    }
    try {
        for (const op of ops) {
            applyOperation(root, op);
        }
    } catch (e) {
        throw new Error(`[trame] Extension du template "${templateName}" : ${(e as Error).message}`);
    } finally {
        for (const node of nodes) {
            node.parent = null;
        }
    }
}

function applyOperation(root: XElement, op: XElement): void {
    const position = getAttr(op, "position") ?? "inside";
    let target: XElement | undefined;
    if (op.tag === "xpath") {
        const expr = getAttr(op, "expr");
        if (!expr) {
            throw new Error('<xpath> sans attribut "expr"');
        }
        target = evaluate(root, expr)[0];
        if (target === undefined) {
            throw new Error(`aucun élément ne correspond à "${expr}"`);
        }
    } else {
        const wanted = op.attrs.filter((a) => a.name !== "position");
        target = findFirst(root, (el) => el.tag === op.tag && wanted.every((a) => getAttr(el, a.name) === a.value));
        if (target === undefined) {
            const desc = wanted.map((a) => `${a.name}="${a.value}"`).join(" ");
            throw new Error(`aucun élément <${op.tag} ${desc}> trouvé`);
        }
    }
    const parent = target.parent!;
    const content = op.children.map((c) => cloneNode(c));
    switch (position) {
        case "inside":
            for (const node of content) {
                node.parent = target;
                target.children.push(node);
            }
            break;
        case "before":
        case "after": {
            const index = parent.children.indexOf(target) + (position === "after" ? 1 : 0);
            for (const node of content) {
                node.parent = parent;
            }
            parent.children.splice(index, 0, ...content);
            break;
        }
        case "replace": {
            const index = parent.children.indexOf(target);
            const replacement: XNode[] = [];
            for (const node of content) {
                replaceMarker(node, target, replacement);
            }
            for (const node of replacement) {
                node.parent = parent;
            }
            parent.children.splice(index, 1, ...replacement);
            break;
        }
        case "attributes":
            for (const child of op.children) {
                if (child.type !== "element" || child.tag !== "attribute") {
                    continue;
                }
                applyAttribute(target, child);
            }
            break;
        default:
            throw new Error(`position inconnue "${position}"`);
    }
}

/** Remplace le texte « $0 » par l'élément d'origine. */
function replaceMarker(node: XNode, original: XElement, out: XNode[]): void {
    if (node.type === "text" && node.value.trim() === "$0") {
        out.push(original);
        return;
    }
    if (node.type === "element") {
        const children: XNode[] = [];
        for (const child of node.children) {
            replaceMarker(child, original, children);
        }
        node.children = children;
        for (const child of children) {
            child.parent = node;
        }
    }
    out.push(node);
}

function applyAttribute(target: XElement, spec: XElement): void {
    const name = getAttr(spec, "name");
    if (!name) {
        throw new Error('<attribute> sans attribut "name"');
    }
    const add = getAttr(spec, "add");
    const remove = getAttr(spec, "remove");
    if (add !== undefined || remove !== undefined) {
        const separator = getAttr(spec, "separator") ?? (name === "class" ? " " : ",");
        const split = (v: string) =>
            v
                .split(separator)
                .map((s) => s.trim())
                .filter(Boolean);
        let values = split(getAttr(target, name) ?? "");
        if (remove !== undefined) {
            const toRemove = new Set(split(remove));
            values = values.filter((v) => !toRemove.has(v));
        }
        if (add !== undefined) {
            for (const v of split(add)) {
                if (!values.includes(v)) {
                    values.push(v);
                }
            }
        }
        const joined = values.join(separator === " " ? " " : separator);
        if (joined) {
            setAttr(target, name, joined);
        } else {
            removeAttr(target, name);
        }
        return;
    }
    const text = spec.children.map((c) => (c.type === "text" ? c.value : "")).join("").trim();
    if (text) {
        setAttr(target, name, text);
    } else {
        removeAttr(target, name);
    }
}

function findFirst(root: XElement, predicate: (el: XElement) => boolean): XElement | undefined {
    for (const child of root.children) {
        if (child.type === "element") {
            if (predicate(child)) {
                return child;
            }
            const found = findFirst(child, predicate);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

// --- Évaluation xpath ----------------------------------------------------------------------------

interface Step {
    descendant: boolean;
    name: string;
    predicates: string[];
}

function parseSteps(expr: string): Step[] {
    const steps: Step[] = [];
    let i = 0;
    const n = expr.length;
    let descendant = false;
    if (expr.startsWith("//")) {
        descendant = true;
        i = 2;
    } else if (expr.startsWith("/")) {
        i = 1;
    } else {
        descendant = true; // expression relative : cherchée partout
    }
    while (i < n) {
        let name = "";
        while (i < n && expr[i] !== "/" && expr[i] !== "[") {
            name += expr[i++];
        }
        const predicates: string[] = [];
        while (expr[i] === "[") {
            let depth = 0;
            let quote = "";
            const start = i + 1;
            for (; i < n; i++) {
                const c = expr[i];
                if (quote) {
                    if (c === quote) {
                        quote = "";
                    }
                } else if (c === "'" || c === '"') {
                    quote = c;
                } else if (c === "[") {
                    depth++;
                } else if (c === "]") {
                    depth--;
                    if (depth === 0) {
                        break;
                    }
                }
            }
            predicates.push(expr.slice(start, i).trim());
            i++;
        }
        steps.push({ descendant, name: name.trim(), predicates });
        descendant = false;
        if (expr.startsWith("//", i)) {
            descendant = true;
            i += 2;
        } else if (expr[i] === "/") {
            i++;
        }
    }
    return steps;
}

function evaluate(root: XElement, expr: string): XElement[] {
    let context: XElement[] = [root];
    for (const step of parseSteps(expr)) {
        const next: XElement[] = [];
        for (const node of context) {
            let candidates: XElement[];
            if (step.name === ".") {
                candidates = [node];
            } else if (step.name === "..") {
                candidates = node.parent ? [node.parent] : [];
            } else {
                const pool = step.descendant ? descendants(node) : elementChildren(node);
                candidates = pool.filter((el) => step.name === "*" || el.tag === step.name);
            }
            for (const predicate of step.predicates) {
                candidates = applyPredicate(candidates, predicate);
            }
            for (const c of candidates) {
                if (!next.includes(c)) {
                    next.push(c);
                }
            }
        }
        context = next;
    }
    return context;
}

function elementChildren(node: XElement): XElement[] {
    return node.children.filter((c): c is XElement => c.type === "element");
}

function descendants(node: XElement): XElement[] {
    const result: XElement[] = [];
    const walk = (el: XElement) => {
        for (const child of el.children) {
            if (child.type === "element") {
                result.push(child);
                walk(child);
            }
        }
    };
    walk(node);
    return result;
}

function applyPredicate(nodes: XElement[], predicate: string): XElement[] {
    if (/^\d+$/.test(predicate)) {
        const node = nodes[parseInt(predicate, 10) - 1];
        return node ? [node] : [];
    }
    if (predicate === "last()") {
        return nodes.length ? [nodes[nodes.length - 1]] : [];
    }
    return nodes.filter((el) => testCondition(el, predicate));
}

function unquote(s: string): string {
    const t = s.trim();
    return t.length >= 2 && (t[0] === "'" || t[0] === '"') ? t.slice(1, -1) : t;
}

function testCondition(el: XElement, cond: string): boolean {
    const parts = cond.split(/\s+and\s+/);
    if (parts.length > 1) {
        return parts.every((p) => testCondition(el, p));
    }
    const c = cond.trim();
    let m = /^@([\w:.\-]+)\s*=\s*(.+)$/.exec(c);
    if (m) {
        return getAttr(el, m[1]) === unquote(m[2]);
    }
    m = /^@([\w:.\-]+)$/.exec(c);
    if (m) {
        return getAttr(el, m[1]) !== undefined;
    }
    m = /^hasclass\((.+)\)$/.exec(c);
    if (m) {
        const classes = (getAttr(el, "class") ?? "").split(/\s+/);
        return m[1].split(",").every((cls) => classes.includes(unquote(cls)));
    }
    m = /^contains\(\s*@([\w:.\-]+)\s*,\s*(.+)\)$/.exec(c);
    if (m) {
        return (getAttr(el, m[1]) ?? "").includes(unquote(m[2]));
    }
    m = /^not\((.+)\)$/.exec(c);
    if (m) {
        return !testCondition(el, m[1]);
    }
    throw new Error(`prédicat xpath non supporté : [${cond}]`);
}
