/**
 * Génération de code : AST → fonction JS de rendu.
 *
 * Pour chaque bloc (le template, une branche de t-if, une ligne de t-foreach, un slot...) :
 * - la partie statique est décrite une fois (`$h.tpl(...)`), construite une seule fois puis clonée ;
 * - le code navigue jusqu'aux nœuds dynamiques (firstChild / nextSibling), puis crée un petit effet
 *   par liaison : seul le nœud concerné est mis à jour quand un signal change.
 *
 * Le code généré n'utilise que de la syntaxe ES2015 (compatibilité navigateurs).
 */

import { compileExpression, type ExpressionScope, isSimplePath } from "./expression";
import type { AST, ASTComponent, ASTElement, Namespace, Pos, TextPart } from "./parser";

export type CompileMode = "component" | "call";

/** Nœud de la partie statique d'un bloc. */
interface SpecElement {
    kind: "el";
    tag: string;
    ns: Namespace;
    noTranslate?: boolean;
    attrs: [string, string][];
    children: SpecNode[];
    varName?: string;
    needed?: boolean;
}

interface SpecText {
    kind: "text";
    value: string;
    raw?: boolean;
    varName?: string;
    needed?: boolean;
}

type SpecNode = SpecElement | SpecText;

/** Racine d'un bloc : un nœud statique, ou une région (variable JS). */
type RootEntry = { spec: SpecNode; region?: string };

const PROPERTY_ATTRS = new Set(["value", "checked", "selected", "indeterminate", "muted"]);

class Scope implements ExpressionScope {
    constructor(
        private readonly parent: Scope | null,
        private readonly vars: Map<string, string>,
        private readonly mode: CompileMode,
        /** Appelé quand une variable de cette portée est utilisée. */
        private readonly onUse: ((name: string) => void) | null = null,
    ) {}

    static root(mode: CompileMode): Scope {
        return new Scope(null, new Map(), mode);
    }

    with(name: string, code: string): Scope {
        return new Scope(this, new Map([[name, code]]), this.mode);
    }

    withAll(entries: [string, string][], onUse: ((name: string) => void) | null = null): Scope {
        return new Scope(this, new Map(entries), this.mode, onUse);
    }

    resolve(name: string): string | undefined {
        let scope: Scope | null = this;
        while (scope !== null) {
            const code = scope.vars.get(name);
            if (code !== undefined) {
                scope.onUse?.(name);
                return code;
            }
            scope = scope.parent;
        }
        return undefined;
    }

    free(name: string): string {
        if (name === "this") {
            return "$c";
        }
        if (this.mode === "call") {
            // Template appelé par t-call : les paramètres passés ont priorité sur le composant.
            // On résout l'objet cible (et non la valeur) : affectations et appels de méthode restent valides.
            return `(${JSON.stringify(name)} in $p ? $p : $c).${name}`;
        }
        return `$c.${name}`;
    }
}

export class CodeGenerator {
    private readonly statics: string[] = [];
    private readonly locations = new Map<string, string>();
    private counter = 0;
    /** Position du nœud en cours de génération (messages d'erreur de compilation). */
    pos: Pos | undefined = undefined;

    constructor(
        private readonly mode: CompileMode,
        private readonly templateName: string,
    ) {}

    uid(prefix: string): string {
        return `${prefix}${++this.counter}`;
    }

    addStatic(code: string): string {
        const name = this.uid("T");
        this.statics.push(`const ${name} = ${code};`);
        return name;
    }

    expr(src: string, scope: Scope): string {
        try {
            return compileExpression(src, scope);
        } catch (e) {
            throw new Error(`[trame] ${this.describe(this.pos)} : ${(e as Error).message}`);
        }
    }

    /** « template "X", ligne N » (avec l'origine si le nœud vient d'une extension). */
    describe(pos: Pos | undefined): string {
        let text = `template "${this.templateName}"`;
        if (pos?.origin) {
            text += ` (${pos.origin})`;
        }
        if (pos?.line !== undefined) {
            text += `, ligne ${pos.line}`;
        }
        return text;
    }

    /**
     * Localisation d'une liaison, pour les erreurs d'exécution en mode dev. Déclarée une fois
     * (constante du template) et passée par référence : aucun coût à l'exécution.
     */
    location(pos: Pos | undefined, snippet: string): string {
        const clean = snippet.replace(/\s+/g, " ").trim();
        const text = `${this.describe(pos)} : ${clean.length > 120 ? clean.slice(0, 117) + "..." : clean}`;
        let name = this.locations.get(text);
        if (name === undefined) {
            name = this.uid("L");
            this.locations.set(text, name);
            this.statics.push(`const ${name} = ${JSON.stringify(text)};`);
        }
        return name;
    }

    generate(ast: AST): string {
        const scope = Scope.root(this.mode);
        const body = new BlockBuilder(this).build(ast, scope);
        return `"use strict";\n${this.statics.join("\n")}\nreturn function render($c, $s, $p) {\n${body}\n};`;
    }
}

class BlockBuilder {
    private readonly roots: RootEntry[] = [];
    private readonly ops: string[] = [];
    /** Composants statiques du bloc : région et index de leur instruction (voir finish). */
    private readonly components: { region: string; op: number }[] = [];

    /**
     * @param exclusive  le bloc est construit sous un scope qui lui est propre (ligne, branche, slot...) ;
     *                   faux pour le bloc racine d'un template, construit sous le scope du composant.
     */
    constructor(
        private readonly gen: CodeGenerator,
        private readonly exclusive = false,
    ) {}

    /** Construit le corps d'une fonction qui crée le bloc et renvoie ses racines. */
    build(ast: AST, scope: Scope): string {
        this.addChildren(null, [ast], scope);
        if (this.roots.length === 0) {
            // Un bloc a toujours au moins un nœud (point d'ancrage pour les déplacements).
            this.roots.push({ spec: { kind: "text", value: "" } });
        }
        return this.finish();
    }

    private addChildren(parent: SpecElement | null, children: AST[], scope: Scope): void {
        let current = scope;
        for (const child of children) {
            current = this.addNode(parent, child, current);
        }
    }

    private pushSpec(parent: SpecElement | null, spec: SpecNode, region?: string): void {
        if (parent === null) {
            this.roots.push({ spec, region });
        } else {
            parent.children.push(spec);
        }
    }

    /** Ajoute un point d'ancrage (nœud texte vide) et renvoie son nom de variable. */
    private anchor(parent: SpecElement | null, regionVar: string): string {
        const spec: SpecText = { kind: "text", value: "", needed: true, varName: this.gen.uid("a") };
        this.pushSpec(parent, spec, regionVar);
        return spec.varName!;
    }

    /** Renvoie la portée à utiliser pour les nœuds frères suivants (t-set). */
    private addNode(parent: SpecElement | null, ast: AST, scope: Scope): Scope {
        const gen = this.gen;
        if ("pos" in ast && ast.pos !== undefined) {
            gen.pos = ast.pos;
        }
        switch (ast.type) {
            case "text":
                this.pushSpec(parent, { kind: "text", value: ast.value, raw: ast.raw });
                return scope;
            case "textExpr": {
                const spec: SpecText = { kind: "text", value: "", needed: true, varName: gen.uid("n") };
                this.pushSpec(parent, spec);
                const loc = gen.location(ast.pos, partsSource(ast.parts));
                this.ops.push(`$h.text(${spec.varName}, () => ${this.parts(ast.parts, scope)}, ${loc});`);
                return scope;
            }
            case "multi":
                this.addChildren(parent, ast.children, scope);
                return scope;
            case "element":
                this.addElement(parent, ast, scope);
                return scope;
            case "set": {
                const name = gen.uid("v");
                this.ops.push(`const ${name} = $h.computed(() => (${gen.expr(ast.value, scope)}));`);
                return scope.with(ast.name, `${name}.get()`);
            }
            case "out": {
                const region = gen.uid("r");
                const anchor = this.anchor(parent, region);
                const loc = gen.location(ast.pos, `t-out="${ast.expr}"`);
                this.ops.push(`const ${region} = $h.out(${anchor}, () => (${gen.expr(ast.expr, scope)}), ${loc});`);
                return scope;
            }
            case "if": {
                const region = gen.uid("r");
                const anchor = this.anchor(parent, region);
                let key = "";
                ast.branches.forEach((branch, i) => {
                    key += branch.cond === null ? `${i}` : `(${gen.expr(branch.cond, scope)}) ? ${i} : `;
                });
                if (ast.branches[ast.branches.length - 1].cond !== null) {
                    key += "-1";
                }
                const loc = gen.location(ast.pos, `t-if="${ast.branches[0].cond}"`);
                const builders = ast.branches.map((b) => this.subBlock(b.body, scope, []));
                this.ops.push(`const ${region} = $h.sw(${anchor}, () => ${key}, [${builders.join(", ")}], ${loc});`);
                return scope;
            }
            case "foreach": {
                const region = gen.uid("r");
                const anchor = this.anchor(parent, region);
                const item = gen.uid("it");
                const index = gen.uid("ix");
                const keyScope = scope.withAll([
                    [ast.as, "v"],
                    [`${ast.as}_index`, "i"],
                ]);
                const keyFn = ast.key === null ? "null" : `(v, i) => (${gen.expr(ast.key, keyScope)})`;
                let usesIndex = false;
                const rowScope = scope.withAll(
                    [
                        [ast.as, `${item}.get()`],
                        [`${ast.as}_index`, `${index}.get()`],
                    ],
                    (name) => {
                        if (name === `${ast.as}_index`) {
                            usesIndex = true;
                        }
                    },
                );
                const loc = gen.location(ast.pos, `t-foreach="${ast.collection}"` + (ast.key ? ` t-key="${ast.key}"` : ""));
                const collection = gen.expr(ast.collection, scope);
                const rowFn = this.subBlock(ast.body, rowScope, [item, index]);
                // Signal d'index créé seulement si le template lit `x_index`.
                this.ops.push(`const ${region} = $h.each(${anchor}, () => (${collection}), ${keyFn}, ${rowFn}, ${loc}, ${usesIndex ? 1 : 0});`);
                return scope;
            }
            case "component": {
                const region = gen.uid("r");
                const anchor = this.anchor(parent, region);
                if (ast.dynamic === null) {
                    this.components.push({ region, op: this.ops.length });
                }
                this.ops.push(`const ${region} = ${this.component(ast, anchor, scope)};`);
                return scope;
            }
            case "slot": {
                const region = gen.uid("r");
                const anchor = this.anchor(parent, region);
                const params = ast.params.length ? this.getters(ast.params.map((p) => [p.name, gen.expr(p.expr, scope)])) : "null";
                const fallback = ast.fallback ? this.subBlock(ast.fallback, scope, []) : "null";
                const loc = gen.location(ast.pos, `t-slot="${ast.name}"`);
                this.ops.push(`const ${region} = $h.slot(${anchor}, $s, ${JSON.stringify(ast.name)}, ${params}, ${fallback}, ${loc});`);
                return scope;
            }
            case "keyed": {
                const region = gen.uid("r");
                const anchor = this.anchor(parent, region);
                const loc = gen.location(ast.pos, `t-key="${ast.key}"`);
                const builder = this.subBlock(ast.body, scope, []);
                this.ops.push(`const ${region} = $h.keyed(${anchor}, () => (${gen.expr(ast.key, scope)}), ${builder}, ${loc});`);
                return scope;
            }
            case "call": {
                const region = gen.uid("r");
                const anchor = this.anchor(parent, region);
                const params = this.getters(ast.params.map((p) => [p.name, gen.expr(p.expr, scope)]));
                const loc = gen.location(ast.pos, `t-call="${ast.template}"`);
                this.ops.push(`const ${region} = $h.call(${anchor}, ${JSON.stringify(ast.template)}, $c, $s, ${params}, ${loc});`);
                return scope;
            }
        }
    }

    private addElement(parent: SpecElement | null, ast: ASTElement, scope: Scope): void {
        const gen = this.gen;
        const spec: SpecElement = { kind: "el", tag: ast.tag, ns: ast.ns, attrs: ast.attrs.slice(), children: [], noTranslate: ast.noTranslate };
        this.pushSpec(parent, spec);
        const own: string[] = [];
        const el = (): string => {
            if (!spec.varName) {
                spec.varName = gen.uid("n");
                spec.needed = true;
            }
            return spec.varName;
        };
        for (const attr of ast.dynAttrs) {
            const value = attr.parts ? this.parts(attr.parts, scope) : `(${gen.expr(attr.expr!, scope)})`;
            const name = attr.name;
            const loc = gen.location(ast.pos, attr.parts ? `${name}="${partsSource(attr.parts)}"` : `t-att-${name}="${attr.expr}"`);
            if (name === "class") {
                own.push(`$h.cls(${el()}, () => ${value}, ${loc});`);
            } else if (name === "style") {
                own.push(`$h.style(${el()}, () => ${value}, ${loc});`);
            } else if (PROPERTY_ATTRS.has(name) && ast.ns === "html") {
                own.push(`$h.prop(${el()}, ${JSON.stringify(name)}, () => ${value}, ${loc});`);
            } else {
                own.push(`$h.attr(${el()}, ${JSON.stringify(name)}, () => ${value}, ${loc});`);
            }
        }
        if (ast.attrsSpread) {
            const loc = gen.location(ast.pos, `t-att="${ast.attrsSpread}"`);
            own.push(`$h.attrs(${el()}, () => (${gen.expr(ast.attrsSpread, scope)}), ${loc});`);
        }
        for (const event of ast.events) {
            const mods = event.modifiers.length ? "." + event.modifiers.join(".") : "";
            const loc = gen.location(ast.pos, `t-on-${event.name}${mods}="${event.expr}"`);
            own.push(
                `$h.on(${el()}, ${JSON.stringify(event.name)}, ${this.handler(event.expr, scope)}, ${JSON.stringify(event.modifiers.join(","))}, ${loc});`,
            );
        }
        if (ast.ref) {
            own.push(`$h.ref(${el()}, (el) => { ${gen.expr(ast.ref, scope)} = el; });`);
        }
        // <select> : la valeur doit être appliquée après la création des <option>.
        if (ast.tag === "select") {
            this.addChildren(spec, ast.children, scope);
            this.ops.push(...own);
        } else {
            this.ops.push(...own);
            this.addChildren(spec, ast.children, scope);
        }
    }

    private component(ast: ASTComponent, anchor: string, scope: Scope): string {
        const gen = this.gen;
        const props: [string, string][] = ast.props.map((p) => [p.name, p.parts ? this.parts(p.parts, scope) : `(${gen.expr(p.expr!, scope)})`]);
        let propsCode = this.getters(props);
        if (ast.spread) {
            propsCode = `$h.props(${propsCode}, () => (${gen.expr(ast.spread, scope)}))`;
        }
        let slotsCode = "null";
        if (ast.slots.length) {
            const entries = ast.slots.map((slot) => {
                const param = gen.uid("sc");
                const slotScope = slot.scope ? scope.with(slot.scope, param) : scope;
                return `${JSON.stringify(slot.name)}: ${this.subBlock(slot.body, slotScope, [param])}`;
            });
            slotsCode = `{ ${entries.join(", ")} }`;
        }
        if (ast.dynamic !== null) {
            const loc = gen.location(ast.pos, `t-component="${ast.dynamic}"`);
            return `$h.dyn(${anchor}, $c, () => (${gen.expr(ast.dynamic, scope)}), ${propsCode}, ${slotsCode}, ${loc})`;
        }
        const loc = gen.location(ast.pos, `<${ast.name}>`);
        return `$h.comp(${anchor}, $c, ${JSON.stringify(ast.name)}, ${propsCode}, ${slotsCode}, ${loc})`;
    }

    private handler(src: string, scope: Scope): string {
        const code = this.gen.expr(src, scope);
        if (isSimplePath(src)) {
            // t-on-click="save" → appel de méthode (this conservé)
            return `(ev) => ${code}(ev)`;
        }
        // Expression : si elle renvoie une fonction (ex. fonction fléchée), on l'appelle avec l'événement.
        // Le résultat est renvoyé : une promesse rejetée remonte ainsi au gestionnaire d'erreurs.
        return `(ev) => { const r = (${code}); return typeof r === "function" ? r(ev) : r; }`;
    }

    private getters(entries: [string, string][]): string {
        if (entries.length === 0) {
            return "{}";
        }
        return `{ ${entries.map(([name, code]) => `get ${JSON.stringify(name)}() { return ${code}; }`).join(", ")} }`;
    }

    private parts(parts: TextPart[], scope: Scope): string {
        if (parts.length === 1 && parts[0].expr !== undefined) {
            return `$h.s(${this.gen.expr(parts[0].expr, scope)})`;
        }
        return parts.map((p) => (p.expr !== undefined ? `$h.s(${this.gen.expr(p.expr, scope)})` : JSON.stringify(p.text))).join(" + ");
    }

    private subBlock(ast: AST, scope: Scope, params: string[]): string {
        const body = new BlockBuilder(this.gen, true).build(ast, scope);
        return `(${params.join(", ")}) => {\n${body}\n}`;
    }

    // --- Assemblage ------------------------------------------------------------------------------

    private finish(): string {
        const gen = this.gen;
        // Composant seul dans un bloc qui a son propre scope : il l'utilise directement (un scope de moins).
        if (this.exclusive && this.roots.length === 1) {
            const solo = this.components.find((c) => c.region === this.roots[0].region);
            if (solo !== undefined) {
                this.ops[solo.op] = this.ops[solo.op].replace(/\);$/, ", 1);");
            }
        }
        const nav: string[] = [];
        // Une racine unique qui est l'ancre d'une région doit avoir un parent : on passe par un fragment.
        const single = this.roots.length === 1 && this.roots[0].region === undefined;
        const tpl = gen.addStatic(`$h.tpl(${JSON.stringify(this.roots.map((r) => encodeSpec(r.spec)))}, ${single ? 0 : 1})`);
        const rootNames: string[] = [];
        if (single) {
            const spec = this.roots[0].spec;
            const root = spec.varName ?? gen.uid("f");
            spec.varName = root;
            nav.push(`const ${root} = ${tpl}();`);
            this.navigate(spec, nav);
            rootNames.push(this.roots[0].region ?? root);
        } else {
            const root = gen.uid("f");
            nav.push(`const ${root} = ${tpl}();`);
            let prev: string | null = null;
            for (const entry of this.roots) {
                const spec = entry.spec;
                const name = spec.varName ?? gen.uid("n");
                spec.varName = name;
                nav.push(`const ${name} = ${prev === null ? `${root}.firstChild` : `${prev}.nextSibling`};`);
                prev = name;
                this.navigate(spec, nav);
                rootNames.push(entry.region ?? name);
            }
        }
        return `${nav.join("\n")}\n${this.ops.join("\n")}\nreturn [${rootNames.join(", ")}];`;
    }

    /** Génère les accès aux nœuds nécessaires dans le sous-arbre de `spec`. */
    private navigate(spec: SpecNode, out: string[]): void {
        if (spec.kind !== "el") {
            return;
        }
        let prevVar: string | null = null;
        let prevIndex = -1;
        spec.children.forEach((child, index) => {
            if (!subtreeNeeded(child)) {
                return;
            }
            const name = child.varName ?? this.gen.uid("n");
            child.varName = name;
            const access: string =
                prevVar === null
                    ? `${spec.varName}.firstChild${".nextSibling".repeat(index)}`
                    : `${prevVar}${".nextSibling".repeat(index - prevIndex)}`;
            out.push(`const ${name} = ${access};`);
            prevVar = name;
            prevIndex = index;
            this.navigate(child, out);
        });
    }
}

/** Texte source d'une interpolation (pour les messages d'erreur). */
function partsSource(parts: TextPart[]): string {
    return parts.map((p) => (p.expr !== undefined ? `{{ ${p.expr} }}` : p.text)).join("");
}

function subtreeNeeded(spec: SpecNode): boolean {
    if (spec.needed) {
        return true;
    }
    return spec.kind === "el" && spec.children.some(subtreeNeeded);
}

/**
 * Encodage compact de la partie statique :
 *   "texte" (traduisible) | { r: "texte" } (non traduit) | [tag, attrs, enfants, ns, sansTraduction?]
 */
function encodeSpec(spec: SpecNode): unknown {
    if (spec.kind === "text") {
        return spec.raw ? { r: spec.value } : spec.value;
    }
    const ns = spec.ns === "svg" ? 1 : spec.ns === "math" ? 2 : 0;
    const encoded: unknown[] = [spec.tag, spec.attrs.length ? spec.attrs : 0, spec.children.length ? spec.children.map(encodeSpec) : 0, ns];
    if (spec.noTranslate) {
        encoded.push(1);
    }
    return encoded;
}

export function generateCode(ast: AST, mode: CompileMode, name: string): string {
    return new CodeGenerator(mode, name).generate(ast);
}
