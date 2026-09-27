import { describe, expect, test } from "vitest";
import { compileExpression, type ExpressionScope } from "../src/compiler/expression";
import { parseXML, serialize } from "../src/compiler/xml";

const scope = (locals: Record<string, string> = {}): ExpressionScope => ({
    resolve: (name) => locals[name],
    free: (name) => (name === "this" ? "$c" : `$c.${name}`),
});

const c = (src: string, locals?: Record<string, string>) => compileExpression(src, scope(locals));

describe("réécriture des expressions", () => {
    test("identifiants libres → membres du composant", () => {
        expect(c("order.total")).toBe("$c.order.total");
        expect(c("a + b * 2")).toBe("$c.a + $c.b * 2");
        expect(c("this.a")).toBe("$c.a");
    });

    test("variables locales", () => {
        expect(c("line.price * qty", { line: "it1.get()" })).toBe("it1.get().price * $c.qty");
    });

    test("globals et mots-clés", () => {
        expect(c("Math.max(a, 1)")).toBe("Math.max($c.a, 1)");
        expect(c("typeof x === 'string' ? true : null")).toBe("typeof $c.x === 'string' ? true : null");
        expect(c("new Date()")).toBe("new Date()");
    });

    test("fonctions fléchées : paramètres laissés tels quels", () => {
        expect(c("(ev) => value = ev.target.value")).toBe("(ev) => $c.value = ev.target.value");
        expect(c("x => x + y")).toBe("x => x + $c.y");
        expect(c("items.map((it, i) => it.id + i)")).toBe("$c.items.map((it, i) => it.id + i)");
        expect(c("({ a, b }) => a + b + d")).toBe("({ a, b }) => a + b + $c.d");
        expect(c("(ev) => { a = 1; save(ev); }")).toBe("(ev) => { $c.a = 1; $c.save(ev); }");
    });

    test("la portée d'une fonction fléchée s'arrête à la virgule", () => {
        expect(c("f((x) => x, x)")).toBe("$c.f((x) => x, $c.x)");
    });

    test("littéraux objets : clés, propriétés raccourcies, spread", () => {
        expect(c("{ red: count > 10, big }")).toBe("{ red: $c.count > 10, big: $c.big }");
        expect(c("{ ...base, a: 1 }")).toBe("{ ...$c.base, a: 1 }");
        expect(c("{ 'a-b': x }")).toBe("{ 'a-b': $c.x }");
        expect(c("{ a: b ? c : d }")).toBe("{ a: $c.b ? $c.c : $c.d }");
    });

    test("chaînes, template literals, chaînage optionnel", () => {
        expect(c("'a' + \"b\" + name")).toBe("'a' + \"b\" + $c.name");
        expect(c("`total: ${total} €`")).toBe("`total: ${$c.total} €`");
        expect(c("order?.partner?.name")).toBe("$c.order?.partner?.name");
        expect(c("a ?? b")).toBe("$c.a ?? $c.b");
    });

    test("macros loading / error / refresh", () => {
        expect(c("loading(order)")).toBe("$h.loading(() => ($c.order))");
        expect(c("loading(this.order)")).toBe("$h.loading(() => ($c.order))");
        expect(c("!loading(order.partner) && x")).toBe("!$h.loading(() => ($c.order.partner)) && $c.x");
        expect(c("loading(line)", { line: "it1.get()" })).toBe("$h.loading(() => (it1.get()))");
        // une variable locale nommée loading reste une variable
        expect(c("loading(x)", { loading: "v1.get()" })).toBe("v1.get()($c.x)");
    });

    test("markup", () => {
        expect(c("markup(html)")).toBe("$h.markup($c.html)");
    });
});

describe("parseur XML", () => {
    test("éléments, attributs, texte, entités, commentaires, CDATA", () => {
        const nodes = parseXML(`<div a="1" b='x &amp; y'><!-- c --><p>a &lt; b &#233;</p><![CDATA[<raw>]]><br/></div>`);
        expect(serialize(nodes)).toBe('<div a="1" b="x &amp; y"><p>a &lt; b é</p>&lt;raw><br/></div>');
    });

    test("plusieurs racines", () => {
        expect(parseXML(`<a/><b/>`).length).toBe(2);
    });

    test("erreurs avec position", () => {
        expect(() => parseXML(`<div><p></div>`)).toThrow(/<\/div> inattendue.*ligne 1/);
        expect(() => parseXML(`<div>`)).toThrow(/non fermée/);
        expect(() => parseXML(`<div a="1" a="2"/>`)).toThrow(/en double/);
        expect(() => parseXML(`<div\n  a=1/>`)).toThrow(/ligne 2/);
    });
});
