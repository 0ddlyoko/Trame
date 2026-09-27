// Tests de robustesse : validité du code généré, absence de fuites, réconciliation des listes.
import { describe, expect, test } from "vitest";
import { compileExpression, type ExpressionScope } from "../src/compiler/expression";
import { Component, nextTick, state, xml } from "../src/index";
import { Signal } from "../src/reactivity/core";
import { render } from "./helpers";

describe("expressions : le code généré est du JavaScript valide", () => {
    const scope: ExpressionScope = {
        resolve: (name) => (name === "line" ? "it1.get()" : undefined),
        free: (name) => (name === "this" ? "$c" : `$c.${name}`),
    };
    const corpus = [
        "order.total.toFixed(2)",
        "a ? b : c ? d : e",
        "{ active: selected, [key]: value, ...rest, name }",
        "[a, , b, ...c]",
        "(ev) => name = ev.target.value",
        "async (ev) => { try { await save(ev); } catch (e) { error = e; } finally { busy = false; } }",
        "() => { const { a, b: [c, d = 1] } = obj; return a + c + d; }",
        "items.map(function (it, i) { var x = it.v * i; return x; })",
        "() => { for (let i = 0, j = n; i < j; i++) { if (i % 2) continue; sum += i; } }",
        "() => { for (const [k, v] of Object.entries(map)) out[k] = v; }",
        "() => { let i = 0; while (i < 3) i++; do { i--; } while (i > 0); return i; }",
        "() => { switch (mode) { case 'a': return 1; default: { const z = 2; return z; } } }",
        "() => { label: for (;;) { break label; } }",
        "({ get x() { return this.y; }, set x(v) { this.y = v; }, m(a = b) { return a; } })",
        "`${line.product} : ${line.total.toFixed(2)} € ${`${nested}`}`",
        "tag`a${b}c`",
        "x?.y?.[z]?.(w) ?? fallback",
        "a ||= b, c &&= d, e ??= f",
        "typeof x === 'undefined' || void 0 === y || !(k in o) || o instanceof Date",
        "new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(amount)",
        "/^\\d+$/.test(input) ? Number(input) : null",
        "a / b / c",
        "loading(order) || error(order.partner)",
        "refresh(line)",
        "line => line.id",
        "(a, { b, c = a }, [d], ...e) => a + b + c + d + e.length",
        "markup(html) && _t('Enregistrer')",
        "n ** 2 >>> 1 << 3 & 7 | 1 ^ 2",
        "a++ + ++b - c-- - --d",
        "-x + +y - ~z",
        "delete obj[key]",
        "0x1f + 0b101 + 0o17 + 1_000 + .5 + 1e3 + 10n",
    ];
    for (const src of corpus) {
        test(src, () => {
            const code = compileExpression(src, scope);
            expect(() => new Function("$c", "$h", "it1", `"use strict"; return (${code});`)).not.toThrow();
        });
    }
});

describe("absence de fuites : les abonnements disparaissent avec les composants", () => {
    test("un signal externe n'a plus d'observateur après la destruction", async () => {
        const external = new Signal(1);
        class C extends Component {
            static template = xml`<p><span t-if="show">{{ value }}</span><b t-foreach="[1, 2, 3]" t-as="i" t-key="i">{{ value + i }}</b></p>`;
            @state accessor show = true;
            get value() {
                return external.get();
            }
        }
        const { destroy } = await render(C);
        expect(external.observed).toBe(true);
        destroy();
        expect(external.observed).toBe(false);
    });

    test("basculer un t-if de nombreuses fois ne fait pas grossir la liste des observateurs", async () => {
        const external = new Signal(1);
        class C extends Component {
            static template = xml`<p><span t-if="show">{{ value }}</span></p>`;
            @state accessor show = true;
            get value() {
                return external.get();
            }
        }
        const { component } = await render(C);
        const initial = external.observerCount;
        for (let i = 0; i < 50; i++) {
            component.show = !component.show;
            await nextTick();
        }
        expect(component.show).toBe(true);
        expect(external.observerCount).toBe(initial);
    });
});

describe("t-foreach : réconciliation sur des permutations aléatoires", () => {
    /** Générateur pseudo-aléatoire déterministe (reproductible). */
    function random(seed: number): () => number {
        let s = seed;
        return () => {
            s = (s * 1103515245 + 12345) % 2147483648;
            return s / 2147483648;
        };
    }

    test("après chaque mise à jour, le DOM correspond à la liste et les lignes conservées sont réutilisées", async () => {
        const rand = random(42);
        class C extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it }}</li></ul>`;
            @state accessor items: number[] = [];
        }
        const { component, fixture } = await render(C);
        let previous = new Map<string, Element>();
        for (let round = 0; round < 60; round++) {
            // Liste aléatoire : sous-ensemble mélangé de 0..29.
            const next = Array.from({ length: 30 }, (_, i) => i).filter(() => rand() < 0.6);
            for (let i = next.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
                [next[i], next[j]] = [next[j], next[i]];
            }
            component.items = next;
            await nextTick();
            const lis = Array.from(fixture.querySelectorAll("li"));
            expect(lis.map((li) => li.textContent)).toEqual(next.map(String));
            for (const li of lis) {
                const old = previous.get(li.textContent!);
                if (old !== undefined) {
                    expect(li).toBe(old);
                }
            }
            previous = new Map(lis.map((li) => [li.textContent!, li]));
        }
    });
});
