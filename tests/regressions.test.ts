// Non-régression : bugs remontés par la relecture du code.
import { describe, expect, test, vi } from "vitest";
import { compileExpression } from "../src/compiler/expression";
import { batch, Component, load, mount, nextTick, registerTemplate, resource, state, xml } from "../src/index";
import { Effect } from "../src/reactivity/core";
import { reactive } from "../src/reactivity/store";
import { deferred, render, settle } from "./helpers";

describe("non-régression", () => {
    test("t-call : affectation et appel de méthode (this conservé)", async () => {
        registerTemplate("reg.counter", `<button class="a" t-on-click="count = count + 1">{{ count }}</button><button class="b" t-on-click="inc">+</button>`);
        class Host extends Component {
            static template = xml`<div><t t-call="reg.counter"/></div>`;
            @state accessor count = 0;
            step = 10;
            inc() {
                this.count += this.step;
            }
        }
        const { fixture } = await render(Host);
        (fixture.querySelector(".a") as HTMLElement).click();
        (fixture.querySelector(".b") as HTMLElement).click();
        expect(fixture.querySelector(".a")!.textContent).toBe("11");
    });

    test("<Suspense> détruit avant d'être prêt : pas d'erreur à l'arrivée des données", async () => {
        const d = deferred<string>();
        const errors: unknown[] = [];
        class Host extends Component {
            static template = xml`<div><t t-if="show"><Suspense><p>{{ data }}</p></Suspense></t></div>`;
            @state accessor show = false;
            @resource accessor data = load(() => d.promise);
        }
        const { component, html } = await render(Host, { onError: (e) => errors.push(e) });
        component.show = true;
        await settle();
        component.show = false;
        await settle();
        d.resolve("x");
        await settle();
        expect(errors).toEqual([]);
        expect(html()).toBe("<div></div>");
    });

    test("<ErrorBoundary> intercepte l'échec d'un premier chargement (sans <Suspense>)", async () => {
        class Fragile extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @resource accessor data = load(async () => {
                throw new Error("404");
            });
        }
        class Page extends Component {
            static template = xml`<div><ErrorBoundary><t t-set-slot="fallback" t-slot-scope="e">KO {{ e.error.message }}</t><Fragile/></ErrorBoundary></div>`;
            static components = { Fragile };
        }
        const { html } = await render(Page);
        expect(html()).toBe("<div>KO 404</div>");
    });

    test("loading() via une variable t-set (computed) ne déclenche pas de chargement", async () => {
        const fetcher = vi.fn(async () => "x");
        class Comp extends Component {
            static template = xml`<div><t t-set="o" t-value="order"/><span t-if="loading(o)">…</span></div>`;
            @resource accessor order = load(fetcher);
        }
        await render(Comp);
        await settle();
        expect(fetcher).not.toHaveBeenCalled();
    });

    test("Map : l'itération voit la modification d'une valeur existante", async () => {
        const map = reactive(new Map([["a", 1]]));
        const log: string[] = [];
        new Effect(() => void log.push([...map.values()].join(",")), null).run();
        map.set("a", 2);
        await nextTick();
        const seen: number[] = [];
        map.forEach((v) => seen.push(v));
        expect(log).toEqual(["1", "2"]);
        expect(seen).toEqual([2]);
    });

    test("nextTick() appelé dans un batch sans écriture se résout", async () => {
        const done = vi.fn();
        batch(() => {
            nextTick().then(done);
        });
        await new Promise((r) => setTimeout(r, 10));
        expect(done).toHaveBeenCalled();
    });

    test("expressions régulières littérales dans les expressions", () => {
        const scope = { resolve: () => undefined, free: (n: string) => `$c.${n}` };
        expect(compileExpression("/^a+$/.test(name)", scope)).toBe("/^a+$/.test($c.name)");
        expect(compileExpression("a / b / c", scope)).toBe("$c.a / $c.b / $c.c");
        expect(compileExpression("name.replace(/[/]x/g, '')", scope)).toBe("$c.name.replace(/[/]x/g, '')");
    });

    test("paramètres de fonction fléchée avec valeur par défaut", () => {
        const scope = { resolve: () => undefined, free: (n: string) => `$c.${n}` };
        expect(compileExpression("(a = b) => a + c", scope)).toBe("(a = $c.b) => a + $c.c");
        expect(compileExpression("({ x = y.z } = {}) => x", scope)).toBe("({ x = $c.y.z } = {}) => x");
    });

    test("AbortError levée par le fetcher lui-même pendant le premier chargement : mount est rejeté", async () => {
        class Comp extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @resource accessor data = load(async () => {
                throw new DOMException("délai dépassé", "AbortError");
            });
        }
        await expect(mount(Comp, document.createElement("div"))).rejects.toThrow("délai dépassé");
    });

    test("clé en double : la liste affichée reste cohérente", async () => {
        const errors: unknown[] = [];
        class List extends Component {
            static template = xml`<p><t t-foreach="items" t-as="x" t-key="x.id">{{ x.v }}</t></p>`;
            @state accessor items = [{ id: 1, v: "a" }];
        }
        const { component, html } = await render(List, { onError: (e) => errors.push(e) });
        component.items = [
            { id: 1, v: "b" },
            { id: 1, v: "c" },
        ];
        await nextTick();
        expect(String(errors[0])).toMatch(/clé en double/);
        expect(html()).toBe("<p>a</p>");
    });
});
