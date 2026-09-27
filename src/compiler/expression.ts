/**
 * Réécriture des expressions JavaScript des templates.
 *
 * Dans un template, on écrit `order.total` (sans `this.`). Le compilateur réécrit chaque identifiant libre :
 * - nom déclaré dans l'expression (paramètre, `const`/`let`/`var`, fonction, `catch`...) → laissé tel quel ;
 * - variable locale du template (t-as, t-set, portée de slot...) → sa variable JS générée ;
 * - global JS connu (Math, JSON...) → laissé tel quel ;
 * - sinon → membre du composant (`$c.order.total`).
 *
 * L'expression est analysée par un vrai parseur (sous-ensemble de JavaScript : expressions, fonctions
 * fléchées ou non, et instructions dans leur corps). Les portées sont donc exactes : une variable
 * déclarée dans le corps d'une fonction n'est pas confondue avec un membre du composant. Le texte
 * d'origine est conservé ; seuls les identifiants concernés sont remplacés.
 *
 * `loading(x)`, `error(x)` et `refresh(x)` sont des macros : l'argument est passé sous forme de
 * fonction, pour être évalué en mode observation (sans déclencher de chargement). Si le composant a une
 * méthode de ce nom, c'est elle qui est appelée (un membre du composant l'emporte toujours).
 */

import { TemplateSyntaxError } from "./xml";

export interface ExpressionScope {
    /** Code JS pour une variable locale du template, ou undefined si ce n'est pas une locale. */
    resolve(name: string): string | undefined;
    /** Code JS pour un identifiant libre (membre du composant par défaut). */
    free(name: string): string;
    /**
     * Code d'un appel `loading(args)` / `error(args)` / `refresh(args)` dont le nom n'est pas une
     * variable locale. Par défaut : la méthode du composant si elle existe, sinon la macro.
     */
    macro?(name: string, args: string): string;
}

/** Appel de macro, sauf si le membre `member` est une fonction (méthode du composant). */
function defaultMacro(scope: ExpressionScope, name: string, args: string): string {
    const member = scope.free(name);
    return `(typeof ${member} === "function" ? ${member}(${args}) : $h.${name}(() => (${args})))`;
}

// --- Tokenizer -----------------------------------------------------------------------------------

type TokenType = "id" | "num" | "str" | "tpl" | "p" | "ws";

interface Token {
    type: TokenType;
    value: string;
    /** Position dans la source (messages d'erreur). */
    start: number;
    /** Position dans sa liste de jetons. */
    index: number;
    /** Template literal : morceaux de texte bruts et jetons de chaque `${...}`. */
    parts?: string[];
    subs?: Token[][];
}

/** Mots réservés : jamais des identifiants (isIdentifier) ni des noms de variables. */
const KEYWORDS = new Set([
    "true",
    "false",
    "null",
    "undefined",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "void",
    "delete",
    "NaN",
    "Infinity",
    "async",
    "await",
    "function",
    "return",
    "if",
    "else",
    "let",
    "const",
    "var",
    "for",
    "while",
    "do",
    "break",
    "continue",
    "switch",
    "case",
    "default",
    "throw",
    "try",
    "catch",
    "finally",
    "yield",
    "class",
    "super",
]);

/** Mots réservés de JavaScript (ne peuvent pas désigner une variable). */
const RESERVED = new Set([
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "await",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const GLOBALS = new Set([
    "Math",
    "JSON",
    "Date",
    "Number",
    "String",
    "Boolean",
    "Object",
    "Array",
    "Symbol",
    "RegExp",
    "Error",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Intl",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
    "encodeURI",
    "decodeURI",
    "console",
    "window",
    "document",
    "navigator",
    "location",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "requestAnimationFrame",
    "BigInt",
]);

const MACROS = new Set(["loading", "error", "refresh"]);
const HELPERS = new Set(["markup", "_t"]);

const PUNCTUATORS = [
    ">>>=",
    "...",
    "===",
    "!==",
    "**=",
    "<<=",
    ">>=",
    ">>>",
    "&&=",
    "||=",
    "??=",
    "=>",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "??",
    "?.",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "**",
    "<<",
    ">>",
];

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);
const BINARY_OPS = new Set(["+", "-", "*", "/", "%", "**", "==", "!=", "===", "!==", "<", ">", "<=", ">=", "<<", ">>", ">>>", "&", "|", "^", "&&", "||", "??"]);
const UNARY_OPS = new Set(["!", "~", "+", "-", "++", "--"]);
const UNARY_WORDS = new Set(["typeof", "void", "delete", "await"]);

const ID_START = /[A-Za-z_$À-￿]/;
const ID_CHAR = /[\w$À-￿]/;

/** Mots-clés après lesquels un "/" commence une expression régulière. */
const REGEX_AFTER_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "yield", "await", "throw", "else", "do"]);

class Tokenizer {
    constructor(private readonly src: string) {}

    private fail(message: string, at: number): never {
        throw new TemplateSyntaxError(`${message} dans l'expression « ${this.src} »`, this.src, at);
    }

    /**
     * Découpe la source à partir de `i`. Avec `inTemplate`, s'arrête sur l'accolade fermante qui
     * termine un `${...}` (renvoie sa position dans `end`).
     */
    tokenize(i: number, inTemplate: boolean): { tokens: Token[]; end: number } {
        const src = this.src;
        const n = src.length;
        const tokens: Token[] = [];
        let braces = 0;
        const push = (type: TokenType, value: string, start: number, extra?: Partial<Token>): void => {
            tokens.push({ type, value, start, index: tokens.length, ...extra });
        };
        while (i < n) {
            const c = src[i];
            const start = i;
            if (/\s/.test(c)) {
                while (i < n && /\s/.test(src[i])) {
                    i++;
                }
                push("ws", src.slice(start, i), start);
                continue;
            }
            if (c === "/" && src[i + 1] === "/") {
                // Commentaire : remplacé par un blanc (il masquerait la suite du code généré).
                while (i < n && src[i] !== "\n") {
                    i++;
                }
                push("ws", " ", start);
                continue;
            }
            if (c === "/" && src[i + 1] === "*") {
                const close = src.indexOf("*/", i + 2);
                if (close === -1) {
                    this.fail("Commentaire non fermé", start);
                }
                i = close + 2;
                push("ws", " ", start);
                continue;
            }
            if (ID_START.test(c)) {
                i++;
                while (i < n && ID_CHAR.test(src[i])) {
                    i++;
                }
                push("id", src.slice(start, i), start);
                continue;
            }
            if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
                const match = /^(?:0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?n?)/.exec(src.slice(i));
                const value = match ? match[0] : c;
                i += value.length;
                push("num", value, start);
                continue;
            }
            if (c === '"' || c === "'") {
                i++;
                while (i < n && src[i] !== c) {
                    if (src[i] === "\\") {
                        i++;
                    }
                    i++;
                }
                if (i >= n) {
                    this.fail("Chaîne non fermée", start);
                }
                i++;
                push("str", src.slice(start, i), start);
                continue;
            }
            if (c === "`") {
                const parts: string[] = [];
                const subs: Token[][] = [];
                let part = "";
                i++;
                for (;;) {
                    if (i >= n) {
                        this.fail("Template literal non fermé", start);
                    }
                    const ch = src[i];
                    if (ch === "\\") {
                        part += ch + (src[i + 1] ?? "");
                        i += 2;
                    } else if (ch === "`") {
                        i++;
                        break;
                    } else if (ch === "$" && src[i + 1] === "{") {
                        parts.push(part);
                        part = "";
                        const sub = this.tokenize(i + 2, true);
                        subs.push(sub.tokens);
                        i = sub.end + 1;
                    } else {
                        part += ch;
                        i++;
                    }
                }
                parts.push(part);
                push("tpl", "", start, { parts, subs });
                continue;
            }
            if (c === "/" && regexAllowed(tokens)) {
                // Expression régulière littérale : recopiée telle quelle.
                let inClass = false;
                i++;
                while (i < n) {
                    const ch = src[i];
                    if (ch === "\\") {
                        i += 2;
                        continue;
                    }
                    if (ch === "[") {
                        inClass = true;
                    } else if (ch === "]") {
                        inClass = false;
                    } else if (ch === "/" && !inClass) {
                        break;
                    } else if (ch === "\n") {
                        this.fail("Expression régulière non fermée", start);
                    }
                    i++;
                }
                if (i >= n) {
                    this.fail("Expression régulière non fermée", start);
                }
                i++;
                while (i < n && /[a-z]/.test(src[i])) {
                    i++;
                }
                push("str", src.slice(start, i), start);
                continue;
            }
            let punct = c;
            for (const p of PUNCTUATORS) {
                if (src.startsWith(p, i)) {
                    punct = p;
                    break;
                }
            }
            // "?." suivi d'un chiffre est un ternaire suivi d'un nombre décimal.
            if (punct === "?." && /[0-9]/.test(src[i + 2] ?? "")) {
                punct = "?";
            }
            if (punct === "{") {
                braces++;
            } else if (punct === "}") {
                if (braces === 0 && inTemplate) {
                    return { tokens, end: i };
                }
                braces--;
            }
            i += punct.length;
            push("p", punct, start);
        }
        if (inTemplate) {
            this.fail("Template literal non fermé", n);
        }
        return { tokens, end: n };
    }
}

/** Un "/" à cette position commence-t-il une expression régulière (et non une division) ? */
function regexAllowed(tokens: Token[]): boolean {
    for (let j = tokens.length - 1; j >= 0; j--) {
        const t = tokens[j];
        if (t.type === "ws") {
            continue;
        }
        if (t.type === "p") {
            return t.value !== ")" && t.value !== "]" && t.value !== "}" && t.value !== "++" && t.value !== "--";
        }
        return t.type === "id" && REGEX_AFTER_KEYWORDS.has(t.value);
    }
    return true;
}

// --- Portées -------------------------------------------------------------------------------------

interface JsScope {
    parent: JsScope | null;
    names: Set<string>;
    /** Portée de fonction : reçoit les `var` et les paramètres. */
    fn: boolean;
    /** Fonction non fléchée (ou méthode) : `this` et `arguments` lui sont propres. */
    ownThis: boolean;
}

function newScope(parent: JsScope | null, fn = false, ownThis = false): JsScope {
    return { parent, names: new Set(), fn, ownThis };
}

function isBound(scope: JsScope | null, name: string): boolean {
    for (let s = scope; s !== null; s = s.parent) {
        if (s.names.has(name)) {
            return true;
        }
    }
    return false;
}

function hasOwnThis(scope: JsScope | null): boolean {
    for (let s = scope; s !== null; s = s.parent) {
        if (s.ownThis) {
            return true;
        }
    }
    return false;
}

/** Identifiant utilisé comme valeur (et non déclaré). */
interface Ref {
    token: Token;
    scope: JsScope;
    /** Propriété raccourcie d'un littéral objet : `{ name }`. */
    shorthand: boolean;
    /** Appel de macro possible : `loading(x)` (jetons des parenthèses, dans la même liste). */
    call: { list: Token[]; open: Token; close: Token } | null;
}

interface Edit {
    /** Dernier jeton remplacé (inclus), dans la même liste que le premier. */
    to: Token;
    render(): string;
}

interface Context {
    readonly src: string;
    readonly refs: Ref[];
    readonly thisRefs: { token: Token; scope: JsScope }[];
}

// --- Parseur -------------------------------------------------------------------------------------

type DeclKind = "var" | "let" | "param";

class Parser {
    private readonly sig: Token[];
    private pos = 0;

    constructor(
        private readonly ctx: Context,
        tokens: Token[],
        private scope: JsScope,
    ) {
        this.sig = tokens.filter((t) => t.type !== "ws");
    }

    // --- Outils ---

    private peek(offset = 0): Token | undefined {
        return this.sig[this.pos + offset];
    }

    private is(value: string, offset = 0): boolean {
        const t = this.sig[this.pos + offset];
        return t !== undefined && (t.type === "p" || t.type === "id") && t.value === value;
    }

    private next(): Token {
        const t = this.sig[this.pos];
        if (t === undefined) {
            this.fail("Fin d'expression inattendue");
        }
        this.pos++;
        return t;
    }

    private expect(value: string): Token {
        if (!this.is(value)) {
            const t = this.peek();
            this.fail(t === undefined ? `« ${value} » attendu en fin d'expression` : `« ${value} » attendu au lieu de « ${describe(t)} »`, t);
        }
        return this.next();
    }

    private fail(message: string, token?: Token): never {
        const src = this.ctx.src;
        throw new TemplateSyntaxError(`${message} dans l'expression « ${src} »`, src, token?.start ?? src.length);
    }

    private within<T>(scope: JsScope, fn: () => T): T {
        const prev = this.scope;
        this.scope = scope;
        try {
            return fn();
        } finally {
            this.scope = prev;
        }
    }

    private declare(name: string, kind: DeclKind, token: Token): void {
        if (RESERVED.has(name)) {
            this.fail(`« ${name} » ne peut pas être un nom de variable`, token);
        }
        let scope = this.scope;
        if (kind === "var") {
            while (!scope.fn && scope.parent !== null) {
                scope = scope.parent;
            }
        }
        scope.names.add(name);
    }

    /** Analyse toute la liste de jetons comme une expression. */
    parseAll(): void {
        if (this.peek() === undefined) {
            this.fail("Expression vide");
        }
        this.parseExpression(false);
        const extra = this.peek();
        if (extra !== undefined) {
            this.fail(`Jeton inattendu « ${describe(extra)} »`, extra);
        }
    }

    // --- Expressions ---

    private parseExpression(noIn: boolean): void {
        this.parseAssign(noIn);
        while (this.is(",")) {
            this.next();
            this.parseAssign(noIn);
        }
    }

    private parseAssign(noIn: boolean): void {
        const t = this.peek();
        if (t !== undefined && t.type === "id") {
            if (t.value === "async" && this.peek(1)?.type === "id" && this.is("=>", 2)) {
                this.next();
                this.parseArrow(noIn);
                return;
            }
            if (t.value === "async" && this.is("(", 1) && this.arrowAhead(this.pos + 1)) {
                this.next();
                this.parseArrow(noIn);
                return;
            }
            if (!RESERVED.has(t.value) && this.is("=>", 1)) {
                this.parseArrow(noIn);
                return;
            }
        }
        if (this.is("(") && this.arrowAhead(this.pos)) {
            this.parseArrow(noIn);
            return;
        }
        this.parseConditional(noIn);
        const op = this.peek();
        if (op !== undefined && op.type === "p" && ASSIGN_OPS.has(op.value)) {
            this.next();
            this.parseAssign(noIn);
        }
    }

    /** Le "(" en position `i` ouvre-t-il les paramètres d'une fonction fléchée ? */
    private arrowAhead(i: number): boolean {
        let depth = 0;
        for (let j = i; j < this.sig.length; j++) {
            const t = this.sig[j];
            if (t.type !== "p") {
                continue;
            }
            if (t.value === "(" || t.value === "[" || t.value === "{") {
                depth++;
            } else if (t.value === ")" || t.value === "]" || t.value === "}") {
                depth--;
                if (depth === 0) {
                    const after = this.sig[j + 1];
                    return after !== undefined && after.type === "p" && after.value === "=>";
                }
            }
        }
        return false;
    }

    private parseArrow(noIn: boolean): void {
        const scope = newScope(this.scope, true, false);
        this.within(scope, () => {
            if (this.is("(")) {
                this.parseParams();
            } else {
                const name = this.next();
                this.declare(name.value, "param", name);
            }
            this.expect("=>");
            if (this.is("{")) {
                this.parseFunctionBody();
            } else {
                this.parseAssign(noIn);
            }
        });
    }

    private parseConditional(noIn: boolean): void {
        this.parseBinary(noIn);
        if (this.is("?")) {
            this.next();
            this.parseAssign(false);
            this.expect(":");
            this.parseAssign(noIn);
        }
    }

    private parseBinary(noIn: boolean): void {
        this.parseUnary();
        for (;;) {
            const t = this.peek();
            if (t === undefined) {
                return;
            }
            const isOp =
                (t.type === "p" && BINARY_OPS.has(t.value)) || (t.type === "id" && (t.value === "instanceof" || (t.value === "in" && !noIn)));
            if (!isOp) {
                return;
            }
            this.next();
            this.parseUnary();
        }
    }

    private parseUnary(): void {
        const t = this.peek();
        if (t !== undefined && ((t.type === "p" && UNARY_OPS.has(t.value)) || (t.type === "id" && UNARY_WORDS.has(t.value)))) {
            this.next();
            this.parseUnary();
            return;
        }
        this.parseLeftHandSide();
        if (this.is("++") || this.is("--")) {
            this.next();
        }
    }

    private parseLeftHandSide(): void {
        let ref: Ref | null = null;
        if (this.is("new")) {
            this.next();
            if (this.is(".")) {
                this.fail("« new.target » n'est pas pris en charge", this.peek());
            }
            this.parseLeftHandSide();
            return;
        }
        ref = this.parsePrimary();
        let first = true;
        for (;;) {
            const t = this.peek();
            if (t === undefined) {
                return;
            }
            if (t.type === "p" && t.value === ".") {
                this.next();
                this.propertyName();
            } else if (t.type === "p" && t.value === "?.") {
                this.next();
                if (this.is("(")) {
                    this.parseArguments();
                } else if (this.is("[")) {
                    this.next();
                    this.parseExpression(false);
                    this.expect("]");
                } else {
                    this.propertyName();
                }
            } else if (t.type === "p" && t.value === "[") {
                this.next();
                this.parseExpression(false);
                this.expect("]");
            } else if (t.type === "p" && t.value === "(") {
                const args = this.parseArguments();
                if (first && ref !== null && MACROS.has(ref.token.value) && args.count > 0) {
                    ref.call = { list: args.list, open: args.open, close: args.close };
                }
            } else if (t.type === "tpl") {
                // Template étiqueté : tag`...`
                this.next();
                this.parseTemplate(t);
            } else {
                return;
            }
            first = false;
        }
    }

    private propertyName(): void {
        const t = this.next();
        if (t.type !== "id") {
            this.fail(`Nom de propriété attendu au lieu de « ${describe(t)} »`, t);
        }
    }

    private parseArguments(): { list: Token[]; open: Token; close: Token; count: number } {
        const open = this.expect("(");
        let count = 0;
        while (!this.is(")")) {
            if (this.is("...")) {
                this.next();
            }
            this.parseAssign(false);
            count++;
            if (!this.is(")")) {
                this.expect(",");
            }
        }
        const close = this.expect(")");
        return { list: this.listOf(open), open, close, count };
    }

    /** Liste de jetons d'origine (avec les blancs) à laquelle appartient `token`. */
    private listOf(token: Token): Token[] {
        return tokenLists.get(token)!;
    }

    /** Renvoie la référence créée si l'expression primaire est un identifiant. */
    private parsePrimary(): Ref | null {
        const t = this.peek();
        if (t === undefined) {
            this.fail("Fin d'expression inattendue");
        }
        switch (t.type) {
            case "num":
            case "str":
                this.next();
                return null;
            case "tpl":
                this.next();
                this.parseTemplate(t);
                return null;
            case "id":
                return this.parseIdentifierPrimary(t);
            case "p":
                break;
            default:
                this.fail(`Jeton inattendu « ${describe(t)} »`, t);
        }
        if (t.value === "(") {
            this.next();
            this.parseExpression(false);
            this.expect(")");
            return null;
        }
        if (t.value === "[") {
            this.next();
            while (!this.is("]")) {
                if (this.is(",")) {
                    this.next();
                    continue;
                }
                if (this.is("...")) {
                    this.next();
                }
                this.parseAssign(false);
                if (!this.is("]")) {
                    this.expect(",");
                }
            }
            this.expect("]");
            return null;
        }
        if (t.value === "{") {
            this.parseObjectLiteral();
            return null;
        }
        this.fail(`Jeton inattendu « ${describe(t)} »`, t);
    }

    private parseIdentifierPrimary(t: Token): Ref | null {
        const v = t.value;
        if (v === "this") {
            this.next();
            this.ctx.thisRefs.push({ token: t, scope: this.scope });
            return null;
        }
        if (v === "function") {
            this.parseFunction(false);
            return null;
        }
        if (v === "async" && this.is("function", 1)) {
            this.next();
            this.parseFunction(false);
            return null;
        }
        if (LITERALS.has(v)) {
            this.next();
            return null;
        }
        if (v === "class" || v === "super" || v === "import" || v === "yield") {
            this.fail(`« ${v} » n'est pas pris en charge dans les templates`, t);
        }
        if (RESERVED.has(v)) {
            this.fail(`Jeton inattendu « ${v} »`, t);
        }
        this.next();
        const ref: Ref = { token: t, scope: this.scope, shorthand: false, call: null };
        this.ctx.refs.push(ref);
        return ref;
    }

    private parseTemplate(t: Token): void {
        for (const sub of t.subs!) {
            new Parser(this.ctx, sub, this.scope).parseAll();
        }
    }

    private isPropertyKeyStart(offset: number): boolean {
        const t = this.peek(offset);
        return t !== undefined && (t.type === "id" || t.type === "str" || t.type === "num" || (t.type === "p" && t.value === "["));
    }

    private parseObjectLiteral(): void {
        this.expect("{");
        while (!this.is("}")) {
            if (this.is("...")) {
                this.next();
                this.parseAssign(false);
            } else {
                let method = false;
                const first = this.peek()!;
                if (first.type === "id" && (first.value === "get" || first.value === "set" || first.value === "async") && this.isPropertyKeyStart(1)) {
                    this.next();
                    method = true;
                }
                if (this.is("*")) {
                    this.next();
                    method = true;
                }
                let keyToken: Token | null = null;
                if (this.is("[")) {
                    this.next();
                    this.parseAssign(false);
                    this.expect("]");
                } else {
                    keyToken = this.next();
                    if (keyToken.type !== "id" && keyToken.type !== "str" && keyToken.type !== "num") {
                        this.fail(`Clé de propriété attendue au lieu de « ${describe(keyToken)} »`, keyToken);
                    }
                }
                if (this.is("(")) {
                    this.parseMethodRest();
                } else if (method) {
                    this.expect("(");
                } else if (this.is(":")) {
                    this.next();
                    this.parseAssign(false);
                } else {
                    // Propriété raccourcie { name } (ou { name = défaut } dans une affectation par décomposition).
                    if (keyToken === null || keyToken.type !== "id" || RESERVED.has(keyToken.value)) {
                        this.fail("« : » attendu après la clé", this.peek());
                    }
                    this.ctx.refs.push({ token: keyToken, scope: this.scope, shorthand: true, call: null });
                    if (this.is("=")) {
                        this.next();
                        this.parseAssign(false);
                    }
                }
            }
            if (!this.is("}")) {
                this.expect(",");
            }
        }
        this.expect("}");
    }

    /** Paramètres et corps d'une méthode (après sa clé). */
    private parseMethodRest(): void {
        this.within(newScope(this.scope, true, true), () => {
            this.parseParams();
            this.parseFunctionBody();
        });
    }

    /** function [nom](params) { corps }. `declaration` : le nom est déclaré dans la portée courante. */
    private parseFunction(declaration: boolean): void {
        this.expect("function");
        if (this.is("*")) {
            this.next();
        }
        const scope = newScope(this.scope, true, true);
        const name = this.peek();
        if (name !== undefined && name.type === "id" && !this.is("(")) {
            this.next();
            if (declaration) {
                this.declare(name.value, "let", name);
            } else {
                scope.names.add(name.value);
            }
        } else if (declaration) {
            this.fail("Nom de fonction attendu", name);
        }
        this.within(scope, () => {
            this.parseParams();
            this.parseFunctionBody();
        });
    }

    private parseParams(): void {
        this.expect("(");
        while (!this.is(")")) {
            if (this.is("...")) {
                this.next();
                this.parseBindingTarget("param");
            } else {
                this.parseBindingElement("param");
            }
            if (!this.is(")")) {
                this.expect(",");
            }
        }
        this.expect(")");
    }

    private parseBindingElement(kind: DeclKind): void {
        this.parseBindingTarget(kind);
        if (this.is("=")) {
            this.next();
            this.parseAssign(false);
        }
    }

    /** Cible d'une déclaration : nom, ou motif de décomposition { a, b: c } / [a, b]. */
    private parseBindingTarget(kind: DeclKind): void {
        const t = this.peek();
        if (t === undefined) {
            this.fail("Nom de variable attendu");
        }
        if (t.type === "id") {
            this.next();
            this.declare(t.value, kind, t);
            return;
        }
        if (this.is("[")) {
            this.next();
            while (!this.is("]")) {
                if (this.is(",")) {
                    this.next();
                    continue;
                }
                if (this.is("...")) {
                    this.next();
                    this.parseBindingTarget(kind);
                } else {
                    this.parseBindingElement(kind);
                }
                if (!this.is("]")) {
                    this.expect(",");
                }
            }
            this.expect("]");
            return;
        }
        if (this.is("{")) {
            this.next();
            while (!this.is("}")) {
                if (this.is("...")) {
                    this.next();
                    this.parseBindingTarget(kind);
                } else if (this.is("[")) {
                    this.next();
                    this.parseAssign(false);
                    this.expect("]");
                    this.expect(":");
                    this.parseBindingElement(kind);
                } else {
                    const key = this.next();
                    if (this.is(":")) {
                        this.next();
                        this.parseBindingElement(kind);
                    } else {
                        if (key.type !== "id") {
                            this.fail(`« : » attendu après « ${describe(key)} »`, this.peek());
                        }
                        this.declare(key.value, kind, key);
                        if (this.is("=")) {
                            this.next();
                            this.parseAssign(false);
                        }
                    }
                }
                if (!this.is("}")) {
                    this.expect(",");
                }
            }
            this.expect("}");
            return;
        }
        this.fail(`Nom de variable attendu au lieu de « ${describe(t)} »`, t);
    }

    // --- Instructions (corps des fonctions) ---

    private parseFunctionBody(): void {
        this.expect("{");
        while (!this.is("}")) {
            this.parseStatement();
        }
        this.expect("}");
    }

    private parseBlock(scope: JsScope = newScope(this.scope)): void {
        this.within(scope, () => {
            this.expect("{");
            while (!this.is("}")) {
                this.parseStatement();
            }
            this.expect("}");
        });
    }

    private semicolon(): void {
        if (this.is(";")) {
            this.next();
        }
    }

    private parseParenthesized(): void {
        this.expect("(");
        this.parseExpression(false);
        this.expect(")");
    }

    private parseStatement(): void {
        const t = this.peek();
        if (t === undefined) {
            this.fail("« } » attendu en fin d'expression");
        }
        if (t.type === "p") {
            if (t.value === "{") {
                this.parseBlock();
                return;
            }
            if (t.value === ";") {
                this.next();
                return;
            }
        }
        if (t.type === "id") {
            switch (t.value) {
                case "var":
                case "let":
                case "const":
                    this.parseDeclarations(false);
                    this.semicolon();
                    return;
                case "function":
                    this.parseFunction(true);
                    return;
                case "async":
                    if (this.is("function", 1)) {
                        this.next();
                        this.parseFunction(true);
                        return;
                    }
                    break;
                case "if":
                    this.next();
                    this.parseParenthesized();
                    this.parseStatement();
                    if (this.is("else")) {
                        this.next();
                        this.parseStatement();
                    }
                    return;
                case "for":
                    this.parseFor();
                    return;
                case "while":
                    this.next();
                    this.parseParenthesized();
                    this.parseStatement();
                    return;
                case "do":
                    this.next();
                    this.parseStatement();
                    this.expect("while");
                    this.parseParenthesized();
                    this.semicolon();
                    return;
                case "return":
                    this.next();
                    if (!this.is(";") && !this.is("}") && this.peek() !== undefined) {
                        this.parseExpression(false);
                    }
                    this.semicolon();
                    return;
                case "throw":
                    this.next();
                    this.parseExpression(false);
                    this.semicolon();
                    return;
                case "break":
                case "continue": {
                    this.next();
                    const label = this.peek();
                    if (label !== undefined && label.type === "id" && !RESERVED.has(label.value)) {
                        this.next();
                    }
                    this.semicolon();
                    return;
                }
                case "try":
                    this.next();
                    this.parseBlock();
                    if (this.is("catch")) {
                        this.next();
                        const scope = newScope(this.scope);
                        this.within(scope, () => {
                            if (this.is("(")) {
                                this.next();
                                this.parseBindingTarget("let");
                                this.expect(")");
                            }
                        });
                        this.parseBlock(newScope(scope));
                    }
                    if (this.is("finally")) {
                        this.next();
                        this.parseBlock();
                    }
                    return;
                case "switch":
                    this.next();
                    this.parseParenthesized();
                    this.within(newScope(this.scope), () => {
                        this.expect("{");
                        while (!this.is("}")) {
                            if (this.is("case")) {
                                this.next();
                                this.parseExpression(false);
                                this.expect(":");
                            } else if (this.is("default")) {
                                this.next();
                                this.expect(":");
                            } else {
                                this.parseStatement();
                            }
                        }
                        this.expect("}");
                    });
                    return;
                case "class":
                    this.fail("« class » n'est pas pris en charge dans les templates", t);
                    break;
                default:
                    if (!RESERVED.has(t.value) && this.is(":", 1)) {
                        // Étiquette : boucle: for (...)
                        this.next();
                        this.next();
                        this.parseStatement();
                        return;
                    }
            }
        }
        this.parseExpression(false);
        this.semicolon();
    }

    /** var / let / const a = 1, { b } = c. Renvoie true si c'est l'en-tête d'un for...of / for...in. */
    private parseDeclarations(inFor: boolean): boolean {
        const keyword = this.next().value;
        const kind: DeclKind = keyword === "var" ? "var" : "let";
        for (;;) {
            this.parseBindingTarget(kind);
            if (inFor && (this.is("of") || this.is("in"))) {
                return true;
            }
            if (this.is("=")) {
                this.next();
                this.parseAssign(inFor);
            }
            if (!this.is(",")) {
                return false;
            }
            this.next();
        }
    }

    private parseFor(): void {
        this.expect("for");
        if (this.is("await")) {
            this.next();
        }
        this.within(newScope(this.scope), () => {
            this.expect("(");
            let iteration = false;
            if (this.is("var") || this.is("let") || this.is("const")) {
                iteration = this.parseDeclarations(true);
            } else if (!this.is(";")) {
                this.parseExpression(true);
                iteration = this.is("of") || this.is("in");
            }
            if (iteration) {
                this.next();
                this.parseAssign(false);
            } else {
                this.expect(";");
                if (!this.is(";")) {
                    this.parseExpression(false);
                }
                this.expect(";");
                if (!this.is(")")) {
                    this.parseExpression(false);
                }
            }
            this.expect(")");
            this.parseStatement();
        });
    }
}

/** Liste d'origine de chaque jeton (renseignée à la découpe). */
const tokenLists = new WeakMap<Token, Token[]>();

function registerLists(tokens: Token[]): void {
    for (const t of tokens) {
        tokenLists.set(t, tokens);
        if (t.subs) {
            for (const sub of t.subs) {
                registerLists(sub);
            }
        }
    }
}

function describe(t: Token): string {
    return t.type === "tpl" ? "`...`" : t.value;
}

// --- Réécriture ----------------------------------------------------------------------------------

/** Compile une expression de template en code JS. */
export function compileExpression(src: string, scope: ExpressionScope): string {
    const tokens = new Tokenizer(src).tokenize(0, false).tokens;
    registerLists(tokens);
    const ctx: Context = { src, refs: [], thisRefs: [] };
    new Parser(ctx, tokens, newScope(null, true, false)).parseAll();

    const edits = new Map<Token, Edit>();
    const emit = (list: Token[], from: number, to: number): string => {
        let out = "";
        for (let i = from; i <= to; i++) {
            const t = list[i];
            const edit = edits.get(t);
            if (edit !== undefined) {
                out += edit.render();
                i = edit.to.index;
                continue;
            }
            if (t.type === "tpl") {
                out += "`";
                t.parts!.forEach((part, k) => {
                    out += part;
                    if (k < t.subs!.length) {
                        const sub = t.subs![k];
                        out += "${" + emit(sub, 0, sub.length - 1) + "}";
                    }
                });
                out += "`";
            } else {
                out += t.value;
            }
        }
        return out;
    };

    for (const { token, scope: jsScope } of ctx.thisRefs) {
        if (!hasOwnThis(jsScope)) {
            const code = scope.free("this");
            edits.set(token, { to: token, render: () => code });
        }
    }

    for (const ref of ctx.refs) {
        const name = ref.token.value;
        if (isBound(ref.scope, name) || (name === "arguments" && hasOwnThis(ref.scope))) {
            continue;
        }
        const local = scope.resolve(name);
        if (local === undefined && ref.call !== null) {
            // Macro : loading(x) → $h.loading(() => (x)), sauf méthode du composant de ce nom.
            const { list, open, close } = ref.call;
            edits.set(ref.token, {
                to: close,
                render: () => {
                    const args = emit(list, open.index + 1, close.index - 1);
                    return scope.macro ? scope.macro(name, args) : defaultMacro(scope, name, args);
                },
            });
            continue;
        }
        const code = local ?? (HELPERS.has(name) ? `$h.${name}` : GLOBALS.has(name) ? name : scope.free(name));
        if (code === name && !ref.shorthand) {
            continue;
        }
        const text = ref.shorthand ? (code === name ? name : `${name}: ${code}`) : code;
        edits.set(ref.token, { to: ref.token, render: () => text });
    }

    return emit(tokens, 0, tokens.length - 1);
}

/** Une expression est-elle un simple chemin (a, a.b, a.b.c) ? Utilisé pour les gestionnaires d'événements. */
export function isSimplePath(src: string): boolean {
    return /^\s*[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/.test(src);
}

/** Vérifie qu'une chaîne est un identifiant JS valide (pour t-as, t-set...). */
export function isIdentifier(name: string): boolean {
    return /^[A-Za-z_$][\w$]*$/.test(name) && !KEYWORDS.has(name);
}
