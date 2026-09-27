import { describe, expect, test } from "vitest";
import { compileExpression, type ExpressionScope } from "../src/compiler/expression";
import { parseXML, serialize } from "../src/compiler/xml";

const scope = (locals: Record<string, string> = {}): ExpressionScope => ({
    resolve: (name) => locals[name],
    free: (name) => (name === "this" ? "$c" : `$c.${name}`),
});

const c = (src: string, locals?: Record<string, string>) => compileExpression(src, scope(locals));

/** Code attendu d'un appel de macro : méthode du composant si elle existe, sinon macro. */
const macro = (name: string, args: string) => `(typeof $c.${name} === "function" ? $c.${name}(${args}) : $h.${name}(() => (${args})))`;

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
        expect(c("loading(order)")).toBe(macro("loading", "$c.order"));
        expect(c("loading(this.order)")).toBe(macro("loading", "$c.order"));
        expect(c("!loading(order.partner) && x")).toBe(`!${macro("loading", "$c.order.partner")} && $c.x`);
        expect(c("loading(line)", { line: "it1.get()" })).toBe(macro("loading", "it1.get()"));
        // une variable locale nommée loading reste une variable
        expect(c("loading(x)", { loading: "v1.get()" })).toBe("v1.get()($c.x)");
    });

    test("markup", () => {
        expect(c("markup(html)")).toBe("$h.markup($c.html)");
    });
});

describe("réécriture des expressions : portées JavaScript", () => {
    test("variables déclarées dans le corps d'une fonction fléchée", () => {
        expect(c("() => { const x = 1; return x + y; }")).toBe("() => { const x = 1; return x + $c.y; }");
        expect(c("() => { let [a, { b }] = pair; return a + b; }")).toBe("() => { let [a, { b }] = $c.pair; return a + b; }");
        expect(c("() => { var n = 0; n++; total = n; }")).toBe("() => { var n = 0; n++; $c.total = n; }");
    });

    test("paramètres de function et fonctions déclarées (hissées)", () => {
        expect(c("items.filter(function (it) { return it.ok; })")).toBe("$c.items.filter(function (it) { return it.ok; })");
        expect(c("() => { return f(1); function f(v) { return v * k; } }")).toBe("() => { return f(1); function f(v) { return v * $c.k; } }");
    });

    test("portée de bloc : let/const ne débordent pas", () => {
        expect(c("() => { if (a) { const x = 1; } return x; }")).toBe("() => { if ($c.a) { const x = 1; } return $c.x; }");
    });

    test("for, for...of, for...in, catch", () => {
        expect(c("() => { for (let i = 0; i < n; i++) { s += i; } }")).toBe("() => { for (let i = 0; i < $c.n; i++) { $c.s += i; } }");
        expect(c("() => { for (const l of lines) total += l.price; }")).toBe("() => { for (const l of $c.lines) $c.total += l.price; }");
        expect(c("() => { for (const k in obj) keys.push(k); }")).toBe("() => { for (const k in $c.obj) $c.keys.push(k); }");
        expect(c("async () => { try { await save(); } catch (e) { error = e.message; } }")).toBe(
            "async () => { try { await $c.save(); } catch (e) { $c.error = e.message; } }",
        );
    });

    test("méthodes et accesseurs d'un littéral objet : this est celui de l'objet", () => {
        expect(c("({ get x() { return this.y + z; } })")).toBe("({ get x() { return this.y + $c.z; } })");
        expect(c("{ f(a) { return a + b; } }")).toBe("{ f(a) { return a + $c.b; } }");
        // Dans une fonction fléchée, this reste le composant.
        expect(c("() => this.save()")).toBe("() => $c.save()");
    });

    test("propriétés raccourcies, clés calculées, affectation par décomposition", () => {
        expect(c("{ [key]: value, name }")).toBe("{ [$c.key]: $c.value, name: $c.name }");
        expect(c("[a, b] = [b, a]")).toBe("[$c.a, $c.b] = [$c.b, $c.a]");
        expect(c("({ a } = obj)")).toBe("({ a: $c.a } = $c.obj)");
    });

    test("template literals imbriqués et paramètres visibles dans ${}", () => {
        expect(c("items.map((i) => `${i.id}-${sep}-${`${i.n}`}`)")).toBe("$c.items.map((i) => `${i.id}-${$c.sep}-${`${i.n}`}`)");
    });

    test("un paramètre masque une variable locale du template", () => {
        expect(c("(line) => line.id + other", { line: "it1.get()", other: "v2.get()" })).toBe("(line) => line.id + v2.get()");
    });

    test("expressions régulières, division et ternaires", () => {
        expect(c("a / b / c")).toBe("$c.a / $c.b / $c.c");
        expect(c("x.match(/a\\/b/g) ? 1 : 2")).toBe("$c.x.match(/a\\/b/g) ? 1 : 2");
        expect(c("a ?.5 : b")).toBe("$c.a ?.5 : $c.b");
    });

    test("mots contextuels utilisables comme noms (of, get, set, async)", () => {
        expect(c("of + get + set")).toBe("$c.of + $c.get + $c.set");
        expect(c("{ get: 1, set }")).toBe("{ get: 1, set: $c.set }");
    });

    test("identifiants accentués (caractères Unicode)", () => {
        expect(c("quantité * prixUnité")).toBe("$c.quantité * $c.prixUnité");
        expect(c("(été) => été + hiver")).toBe("(été) => été + $c.hiver");
    });

    test("opérateurs et formes diverses", () => {
        expect(c("new Foo(a).b")).toBe("new $c.Foo($c.a).b");
        expect(c("a?.[b]?.(c)")).toBe("$c.a?.[$c.b]?.($c.c)");
        expect(c("typeof x === 'y' && !(k in obj) && o instanceof Date")).toBe("typeof $c.x === 'y' && !($c.k in $c.obj) && $c.o instanceof Date");
        expect(c("delete map[k]")).toBe("delete $c.map[$c.k]");
        expect(c("async (x) => await save(x)")).toBe("async (x) => await $c.save(x)");
        expect(c("async x => x")).toBe("async x => x");
        expect(c("[...list, ...[a]]")).toBe("[...$c.list, ...[$c.a]]");
        expect(c("f(...args)")).toBe("$c.f(...$c.args)");
        expect(c("tag`x${y}`")).toBe("$c.tag`x${$c.y}`");
        expect(c("a /* commentaire */ + b // fin")).toBe("$c.a   + $c.b  ");
        expect(c("() => { outer: for (;;) { break outer; } }")).toBe("() => { outer: for (;;) { break outer; } }");
        expect(c("() => { switch (k) { case 1: { const z = 1; return z; } default: return w; } }")).toBe(
            "() => { switch ($c.k) { case 1: { const z = 1; return z; } default: return $c.w; } }",
        );
    });

    test("macros : sans argument, c'est un appel normal", () => {
        expect(c("refresh()")).toBe("$c.refresh()");
        expect(c("(order) => loading(order)")).toBe(`(order) => ${macro("loading", "order")}`);
    });

    test("erreurs de syntaxe claires", () => {
        expect(() => c("a +")).toThrow(/expression/);
        expect(() => c("(a")).toThrow(/expression/);
        expect(() => c("{ a: 1 ")).toThrow(/expression/);
        expect(() => c("a b")).toThrow(/expression/);
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
