/**
 * Réécriture des expressions JavaScript des templates.
 *
 * Dans un template, on écrit `order.total` (sans `this.`). Le compilateur réécrit chaque identifiant libre :
 * - variable locale du template (t-as, t-set, portée de slot...) → sa variable JS générée ;
 * - paramètre d'une fonction fléchée de l'expression → laissé tel quel ;
 * - global JS connu (Math, JSON...) → laissé tel quel ;
 * - sinon → membre du composant (`$c.order.total`).
 *
 * `loading(x)`, `error(x)` et `refresh(x)` sont des macros : l'argument est passé sous forme de
 * fonction, pour être évalué en mode observation (sans déclencher de chargement).
 */

import { TemplateSyntaxError } from "./xml";

export interface ExpressionScope {
    /** Code JS pour une variable locale du template, ou undefined si ce n'est pas une locale. */
    resolve(name: string): string | undefined;
    /** Code JS pour un identifiant libre (membre du composant par défaut). */
    free(name: string): string;
}

type TokenType = "id" | "num" | "str" | "tpl" | "p" | "ws";

interface Token {
    type: TokenType;
    value: string;
    /** Pour les template literals : morceaux de texte et expressions intercalées. */
    parts?: string[];
    exprs?: string[];
}

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

const ID_START = /[A-Za-z_$À-￿]/;
const ID_CHAR = /[\w$À-￿]/;

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const n = src.length;
    const fail = (message: string): never => {
        throw new TemplateSyntaxError(`${message} dans l'expression « ${src} »`, src, i);
    };
    while (i < n) {
        const c = src[i];
        if (/\s/.test(c)) {
            const start = i;
            while (i < n && /\s/.test(src[i])) {
                i++;
            }
            tokens.push({ type: "ws", value: src.slice(start, i) });
            continue;
        }
        if (ID_START.test(c)) {
            const start = i;
            i++;
            while (i < n && ID_CHAR.test(src[i])) {
                i++;
            }
            tokens.push({ type: "id", value: src.slice(start, i) });
            continue;
        }
        if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
            const match = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?n?)/.exec(
                src.slice(i),
            );
            const value = match ? match[0] : c;
            tokens.push({ type: "num", value });
            i += value.length;
            continue;
        }
        if (c === '"' || c === "'") {
            const start = i;
            i++;
            while (i < n && src[i] !== c) {
                if (src[i] === "\\") {
                    i++;
                }
                i++;
            }
            if (i >= n) {
                fail("Chaîne non fermée");
            }
            i++;
            tokens.push({ type: "str", value: src.slice(start, i) });
            continue;
        }
        if (c === "`") {
            const parts: string[] = [];
            const exprs: string[] = [];
            let part = "";
            i++;
            for (;;) {
                if (i >= n) {
                    fail("Template literal non fermé");
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
                    i += 2;
                    const start = i;
                    let depth = 1;
                    while (i < n && depth > 0) {
                        const cc = src[i];
                        if (cc === "{") {
                            depth++;
                        } else if (cc === "}") {
                            depth--;
                        } else if (cc === '"' || cc === "'" || cc === "`") {
                            // saute la chaîne imbriquée
                            const q = cc;
                            i++;
                            while (i < n && src[i] !== q) {
                                if (src[i] === "\\") {
                                    i++;
                                }
                                i++;
                            }
                        }
                        i++;
                    }
                    exprs.push(src.slice(start, i - 1));
                } else {
                    part += ch;
                    i++;
                }
            }
            parts.push(part);
            tokens.push({ type: "tpl", value: "", parts, exprs });
            continue;
        }
        if (c === "/" && regexAllowed(tokens)) {
            // Expression régulière littérale : recopiée telle quelle.
            const start = i;
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
                    fail("Expression régulière non fermée");
                }
                i++;
            }
            if (i >= n) {
                fail("Expression régulière non fermée");
            }
            i++;
            while (i < n && /[a-z]/.test(src[i])) {
                i++;
            }
            tokens.push({ type: "str", value: src.slice(start, i) });
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
        tokens.push({ type: "p", value: punct });
        i += punct.length;
    }
    return tokens;
}

/** Mots-clés après lesquels un "/" commence une expression régulière. */
const REGEX_AFTER_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "yield", "await"]);

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

interface Frame {
    open: string;
    /** "{" : littéral objet (true) ou bloc (false). */
    object: boolean;
    /** Fermeture de macro : on referme aussi la fonction ajoutée. */
    macro: boolean;
}

interface ArrowScope {
    depth: number;
    names: Set<string>;
}

/** Compile une expression de template en code JS. */
export function compileExpression(src: string, scope: ExpressionScope): string {
    const tokens = tokenize(src);
    const out: string[] = [];
    const stack: Frame[] = [];
    const arrows: ArrowScope[] = [];

    const significant = (from: number, step: number): Token | undefined => {
        for (let j = from; j >= 0 && j < tokens.length; j += step) {
            if (tokens[j].type !== "ws") {
                return tokens[j];
            }
        }
        return undefined;
    };
    const isArrowParam = (name: string): boolean => arrows.some((a) => a.names.has(name));
    const top = (): Frame | undefined => stack[stack.length - 1];
    /** Retire les portées de fonctions fléchées terminées (profondeur > depth, ou >= avec inclusive). */
    const popArrows = (depth: number, inclusive = false): void => {
        while (arrows.length) {
            const d = arrows[arrows.length - 1].depth;
            if (d > depth || (inclusive && d === depth)) {
                arrows.pop();
            } else {
                break;
            }
        }
    };

    /** Si le "(" en position i ouvre les paramètres d'une fonction fléchée, renvoie l'index du ")". */
    const arrowParamsEnd = (i: number): number => {
        let depth = 0;
        for (let j = i; j < tokens.length; j++) {
            const t = tokens[j];
            if (t.type !== "p") {
                continue;
            }
            if (t.value === "(" || t.value === "[" || t.value === "{") {
                depth++;
            } else if (t.value === ")" || t.value === "]" || t.value === "}") {
                depth--;
                if (depth === 0) {
                    const next = significant(j + 1, 1);
                    return next !== undefined && next.value === "=>" ? j : -1;
                }
            }
        }
        return -1;
    };

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        switch (tok.type) {
            case "ws":
            case "num":
            case "str":
                out.push(tok.value);
                break;
            case "tpl": {
                let s = "`";
                tok.parts!.forEach((part, k) => {
                    s += part;
                    if (k < tok.exprs!.length) {
                        s += "${" + compileExpression(tok.exprs![k], withArrowParams(scope, arrows)) + "}";
                    }
                });
                out.push(s + "`");
                break;
            }
            case "id": {
                const name = tok.value;
                const prev = significant(i - 1, -1);
                const next = significant(i + 1, 1);
                const frame = top();
                if (prev !== undefined && (prev.value === "." || prev.value === "?.") && prev.type === "p") {
                    out.push(name);
                } else if (name === "this") {
                    out.push(scope.free("this"));
                } else if (KEYWORDS.has(name)) {
                    out.push(name);
                } else if (
                    frame?.open === "{" &&
                    frame.object &&
                    (prev?.value === "{" || prev?.value === ",") &&
                    next?.value === ":"
                ) {
                    // Clé d'un littéral objet
                    out.push(name);
                } else if (next?.value === "=>" ) {
                    // Paramètre unique d'une fonction fléchée : x => ...
                    arrows.push({ depth: stack.length, names: new Set([name]) });
                    out.push(name);
                } else {
                    const code = resolveIdentifier(name, next);
                    if (
                        frame?.open === "{" &&
                        frame.object &&
                        (prev?.value === "{" || prev?.value === ",") &&
                        (next?.value === "," || next?.value === "}")
                    ) {
                        // Propriété raccourcie { name } → { name: <valeur> }
                        out.push(`${name}: ${code}`);
                    } else if (code === null) {
                        // Macro : loading(x) → $h.loading(() => (x))
                        out.push(`$h.${name}(() => (`);
                        // saute jusqu'au "(" qui suit
                        let j = i + 1;
                        while (tokens[j].type === "ws") {
                            j++;
                        }
                        stack.push({ open: "(", object: false, macro: true });
                        i = j;
                    } else {
                        out.push(code);
                    }
                }
                break;
            }
            case "p": {
                const v = tok.value;
                if (v === "(") {
                    const end = arrowParamsEnd(i);
                    if (end !== -1) {
                        // Paramètres de fonction fléchée : les noms restent tels quels et entrent dans la
                        // portée ; les valeurs par défaut (a = b) sont réécrites comme des expressions.
                        const names = new Set<string>();
                        let paramsCode = "";
                        let depth = 0;
                        const inDefault: boolean[] = [false];
                        for (let j = i; j <= end; j++) {
                            const t = tokens[j];
                            if (t.type === "p") {
                                if (t.value === "(" || t.value === "[" || t.value === "{") {
                                    depth++;
                                    inDefault[depth] = false;
                                } else if (t.value === ")" || t.value === "]" || t.value === "}") {
                                    inDefault[depth] = false;
                                    depth--;
                                } else if (t.value === "=") {
                                    inDefault[depth] = true;
                                } else if (t.value === ",") {
                                    inDefault[depth] = false;
                                }
                                paramsCode += t.value;
                            } else if (t.type === "id" && !KEYWORDS.has(t.value)) {
                                const before = significant(j - 1, -1);
                                const isMember = before?.type === "p" && (before.value === "." || before.value === "?.");
                                if (inDefault.slice(1, depth + 1).some(Boolean)) {
                                    paramsCode += isMember ? t.value : (resolveIdentifier(t.value, significant(j + 1, 1)) ?? t.value);
                                } else {
                                    if (significant(j + 1, 1)?.value !== ":" && !isMember) {
                                        names.add(t.value);
                                    }
                                    paramsCode += t.value;
                                }
                            } else if (t.type === "tpl") {
                                let tpl = "`";
                                t.parts!.forEach((part, k) => {
                                    tpl += part;
                                    if (k < t.exprs!.length) {
                                        tpl += "${" + compileExpression(t.exprs![k], withArrowParams(scope, arrows)) + "}";
                                    }
                                });
                                paramsCode += tpl + "`";
                            } else {
                                paramsCode += t.value;
                            }
                        }
                        out.push(paramsCode);
                        arrows.push({ depth: stack.length, names });
                        i = end;
                        break;
                    }
                    stack.push({ open: "(", object: false, macro: false });
                    out.push(v);
                } else if (v === "[") {
                    stack.push({ open: "[", object: false, macro: false });
                    out.push(v);
                } else if (v === "{") {
                    const prev = significant(i - 1, -1);
                    stack.push({ open: "{", object: prev?.value !== "=>", macro: false });
                    out.push(v);
                } else if (v === ")" || v === "]" || v === "}") {
                    const frame = stack.pop();
                    popArrows(stack.length);
                    out.push(frame?.macro ? "))" : v);
                } else if (v === ",") {
                    // Une virgule au même niveau termine le corps d'une fonction fléchée.
                    popArrows(stack.length, true);
                    out.push(v);
                } else {
                    out.push(v);
                }
                break;
            }
        }
    }
    return out.join("");

    function resolveIdentifier(name: string, next: Token | undefined): string | null {
        if (isArrowParam(name)) {
            return name;
        }
        const local = scope.resolve(name);
        if (local !== undefined) {
            return local;
        }
        if (MACROS.has(name) && next?.value === "(") {
            const afterParen = significant(tokens.indexOf(next) + 1, 1);
            if (afterParen?.value !== ")") {
                return null;
            }
        }
        if (HELPERS.has(name)) {
            return `$h.${name}`;
        }
        if (GLOBALS.has(name)) {
            return name;
        }
        return scope.free(name);
    }
}

function withArrowParams(scope: ExpressionScope, arrows: ArrowScope[]): ExpressionScope {
    if (arrows.length === 0) {
        return scope;
    }
    return {
        resolve(name) {
            for (const a of arrows) {
                if (a.names.has(name)) {
                    return name;
                }
            }
            return scope.resolve(name);
        },
        free: (name) => scope.free(name),
    };
}

/** Une expression est-elle un simple chemin (a, a.b, a.b.c) ? Utilisé pour les gestionnaires d'événements. */
export function isSimplePath(src: string): boolean {
    return /^\s*[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/.test(src);
}

/** Vérifie qu'une chaîne est un identifiant JS valide (pour t-as, t-set...). */
export function isIdentifier(name: string): boolean {
    return /^[A-Za-z_$][\w$]*$/.test(name) && !KEYWORDS.has(name);
}
