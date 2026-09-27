/**
 * Vérification des templates par TypeScript.
 *
 * Pour chaque template, on génère du code TypeScript « fantôme » qui reprend chaque expression avec
 * les vrais types : membres du composant, variables de boucle, paramètres d'événements (typés selon
 * la balise), props des composants enfants (vérifiées contre leur schéma props()). Ce code n'est
 * jamais exécuté : il est seulement soumis à `tsc`, et chaque ligne générée est reliée à la ligne
 * du template, pour que les erreurs soient signalées au bon endroit.
 */

import { compileExpression, type ExpressionScope, isSimplePath } from "./expression";
import { type AST, BUILTIN_COMPONENTS, parseTemplate, type Pos, type TextPart } from "./parser";
import { parseXML } from "./xml";

export interface CheckResult {
    /** Lignes du code généré (corps d'une méthode statique à insérer dans la classe). */
    lines: string[];
    /** Pour chaque ligne générée : la ligne du template (relative, à partir de 1), si connue. */
    templateLines: (number | undefined)[];
}

/** Déclarations utilisées par le code généré (à ajouter une fois par fichier, au niveau du module). */
export function checkPrelude(trameModule: string): string {
    return [
        `import type { ComponentPropsInput as __TramePropsInput } from ${JSON.stringify(trameModule)};`,
        `declare function __use(value: unknown): void;`,
        `declare function __iter(value: number): number[];`,
        `declare function __iter<T>(value: Iterable<T> | ArrayLike<T> | null | undefined | false): T[];`,
        `declare function __iter<T>(value: Record<string, T>): T[];`,
        `declare function __on<E>(handler: (ev: E) => unknown): void;`,
        `declare function __props<C>(component: C, props: __TramePropsInput<C>): void;`,
        `declare function __el<K extends string>(): __El<K>;`,
        `declare const $h: { loading(fn: () => unknown): boolean; error(fn: () => unknown): unknown; refresh(fn: () => unknown): void; markup(html: string): unknown; _t(text: string): string };`,
        `type __El<K extends string> = K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : K extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[K] : HTMLElement;`,
        `type __Ev<N extends string, E> = (N extends keyof HTMLElementEventMap ? HTMLElementEventMap[N] : Event) & { target: E; currentTarget: E };`,
    ].join("\n");
}

class CheckScope implements ExpressionScope {
    constructor(
        private readonly parent: CheckScope | null,
        private readonly vars: Map<string, string>,
    ) {}

    with(name: string, code: string): CheckScope {
        return new CheckScope(this, new Map([[name, code]]));
    }

    resolve(name: string): string | undefined {
        for (let s: CheckScope | null = this; s !== null; s = s.parent) {
            const code = s.vars.get(name);
            if (code !== undefined) {
                return code;
            }
        }
        return undefined;
    }

    free(name: string): string {
        return name === "this" ? "$c" : `$c.${name}`;
    }
}

const ARROW = /^\s*(async\s+)?(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Génère le code de vérification d'un template.
 * @param className  classe du composant (référencée comme type de `$c`)
 */
export function generateCheck(source: string, className: string): CheckResult {
    const ast = parseTemplate(parseXML(source));
    const gen = new CheckGenerator(className);
    gen.emit(`const $c = undefined as unknown as ${className};`, undefined);
    gen.node(ast, new CheckScope(null, new Map()), "");
    return { lines: gen.lines, templateLines: gen.map };
}

class CheckGenerator {
    readonly lines: string[] = [];
    readonly map: (number | undefined)[] = [];
    private counter = 0;
    private pos: Pos | undefined;

    constructor(private readonly className: string) {}

    emit(code: string, pos: Pos | undefined): void {
        const line = pos?.origin === undefined ? pos?.line : undefined;
        for (const part of code.split("\n")) {
            this.lines.push(part);
            this.map.push(line);
        }
    }

    private expr(src: string, scope: CheckScope): string {
        return compileExpression(src, scope);
    }

    private use(src: string, scope: CheckScope): void {
        this.emit(`__use(${this.expr(src, scope)});`, this.pos);
    }

    private useParts(parts: TextPart[], scope: CheckScope): void {
        for (const part of parts) {
            if (part.expr !== undefined) {
                this.use(part.expr, scope);
            }
        }
    }

    private uid(prefix: string): string {
        return `__${prefix}${++this.counter}`;
    }

    /** Génère un nœud ; renvoie la portée pour les nœuds frères suivants (t-set). */
    node(ast: AST, scope: CheckScope, tag: string): CheckScope {
        if ("pos" in ast && ast.pos !== undefined) {
            this.pos = ast.pos;
        }
        switch (ast.type) {
            case "text":
                return scope;
            case "textExpr":
                this.useParts(ast.parts, scope);
                return scope;
            case "multi": {
                let s = scope;
                for (const child of ast.children) {
                    s = this.node(child, s, tag);
                }
                return scope;
            }
            case "set": {
                const name = this.uid("v");
                this.emit(`const ${name} = (${this.expr(ast.value, scope)});`, this.pos);
                return scope.with(ast.name, name);
            }
            case "out":
                this.use(ast.expr, scope);
                return scope;
            case "if":
                ast.branches.forEach((branch, i) => {
                    const head = branch.cond === null ? "else {" : `${i === 0 ? "if" : "else if"} (${this.expr(branch.cond, scope)}) {`;
                    this.emit(head, ast.pos);
                    this.block(branch.body, scope, tag);
                    this.emit("}", ast.pos);
                });
                return scope;
            case "foreach": {
                const item = this.uid("it");
                const index = this.uid("ix");
                this.emit(`for (const ${item} of __iter(${this.expr(ast.collection, scope)})) {`, ast.pos);
                this.emit(`const ${index}: number = 0;`, ast.pos);
                const inner = scope.with(ast.as, item).with(`${ast.as}_index`, index);
                if (ast.key !== null) {
                    this.pos = ast.pos;
                    this.use(ast.key, inner);
                }
                this.block(ast.body, inner, tag);
                this.emit("}", ast.pos);
                return scope;
            }
            case "keyed":
                this.use(ast.key, scope);
                this.block(ast.body, scope, tag);
                return scope;
            case "element": {
                const el = `__El<${JSON.stringify(ast.tag)}>`;
                for (const attr of ast.dynAttrs) {
                    if (attr.parts) {
                        this.useParts(attr.parts, scope);
                    } else {
                        this.use(attr.expr!, scope);
                    }
                }
                if (ast.attrsSpread) {
                    this.use(ast.attrsSpread, scope);
                }
                for (const event of ast.events) {
                    this.emit(`__on<__Ev<${JSON.stringify(event.name)}, ${el}>>(${this.handler(event.expr, scope)});`, ast.pos);
                }
                if (ast.ref) {
                    this.emit(`(${this.expr(ast.ref, scope)}) = __el<${JSON.stringify(ast.tag)}>();`, ast.pos);
                }
                if (ast.children.length) {
                    this.emit("{", ast.pos);
                    let s = scope;
                    for (const child of ast.children) {
                        s = this.node(child, s, ast.tag);
                    }
                    this.emit("}", ast.pos);
                }
                return scope;
            }
            case "component": {
                const props = ast.props.map((p) => {
                    const key = IDENT.test(p.name) ? p.name : JSON.stringify(p.name);
                    const value = p.parts ? p.parts.map((x) => (x.expr !== undefined ? `String(${this.expr(x.expr, scope)})` : JSON.stringify(x.text))).join(" + ") : `(${this.expr(p.expr!, scope)})`;
                    return `${key}: ${value}`;
                });
                if (ast.spread) {
                    props.unshift(`...(${this.expr(ast.spread, scope)})`);
                }
                const literal = `{ ${props.join(", ")} }`;
                if (ast.dynamic !== null) {
                    this.use(ast.dynamic, scope);
                    this.emit(`__use(${literal});`, ast.pos);
                } else if (BUILTIN_COMPONENTS.has(ast.name!)) {
                    this.emit(`__use(${literal});`, ast.pos);
                } else {
                    // Composant enfant : il doit être déclaré dans static components, et ses props respectent son schéma.
                    this.emit(`__props(${this.className}.components.${ast.name}, ${literal});`, ast.pos);
                }
                for (const slot of ast.slots) {
                    this.emit("{", ast.pos);
                    let inner = scope;
                    if (slot.scope) {
                        const name = this.uid("sc");
                        this.emit(`const ${name}: any = undefined;`, ast.pos);
                        inner = scope.with(slot.scope, name);
                    }
                    this.node(slot.body, inner, tag);
                    this.emit("}", ast.pos);
                }
                return scope;
            }
            case "slot":
                for (const param of ast.params) {
                    this.use(param.expr, scope);
                }
                if (ast.fallback) {
                    this.block(ast.fallback, scope, tag);
                }
                return scope;
            case "call":
                for (const param of ast.params) {
                    this.use(param.expr, scope);
                }
                return scope;
        }
    }

    private block(ast: AST, scope: CheckScope, tag: string): void {
        this.emit("{", this.pos);
        this.node(ast, scope, tag);
        this.emit("}", this.pos);
    }

    private handler(src: string, scope: CheckScope): string {
        const code = this.expr(src, scope);
        if (ARROW.test(src) || isSimplePath(src)) {
            // Fonction fléchée (paramètre typé par le contexte) ou méthode : vérifiées comme gestionnaires.
            return code;
        }
        // Instruction (ex. count = 0)
        return `(__ev) => { ${code}; }`;
    }
}
