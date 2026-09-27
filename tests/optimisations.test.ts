// Optimisations : le comportement doit rester identique, avec moins d'objets créés.
import { describe, expect, test } from "vitest";
import { Component, nextTick, props, state, t, xml } from "../src/index";
import { render } from "./helpers";

describe("props : schéma partagé par classe", () => {
    test("les validateurs sans paramètre et instanceOf(C) sont partagés", () => {
        class Line {}
        expect(t.string()).toBe(t.string());
        expect(t.number()).toBe(t.number());
        expect(t.boolean()).toBe(t.boolean());
        expect(t.func()).toBe(t.func());
        expect(t.any()).toBe(t.any());
        expect(t.array()).toBe(t.array());
        expect(t.object()).toBe(t.object());
        expect(t.instanceOf(Line)).toBe(t.instanceOf(Line));
        // Les variantes restent des validateurs distincts, sans modifier l'original.
        expect(t.string().optional()).not.toBe(t.string());
        expect(t.string().check(undefined)).not.toBeNull();
    });

    test("this.props garde le même comportement : clés, décomposition, JSON, in, défauts, lecture seule", async () => {
        let view!: Record<string, unknown>;
        class Child extends Component {
            static template = xml`<i>{{ props.label }}-{{ props.size }}</i>`;
            props = props({ label: t.string(), size: t.number().default(3), extra: t.string().optional() });
            constructor() {
                super();
                view = this.props as unknown as Record<string, unknown>;
            }
        }
        class Parent extends Component {
            static template = xml`<Child label="label"/>`;
            static components = { Child };
            @state accessor label = "a";
        }
        const { component, html } = await render(Parent);
        expect(html()).toBe("<i>a-3</i>");
        expect(Object.keys(view)).toEqual(["label", "size", "extra"]);
        expect({ ...view }).toEqual({ label: "a", size: 3, extra: undefined });
        expect(JSON.parse(JSON.stringify(view))).toEqual({ label: "a", size: 3 });
        expect("label" in view).toBe(true);
        expect("inconnue" in view).toBe(false);
        expect(view.inconnue).toBeUndefined();
        expect(typeof view.hasOwnProperty).toBe("function");
        expect(() => {
            view.label = "b";
        }).toThrow(/lecture seule/);
        expect(() => {
            delete view.label;
        }).toThrow(/lecture seule/);
        component.label = "b";
        await nextTick();
        expect(html()).toBe("<i>b-3</i>");
        expect(view.label).toBe("b");
    });

    test("chaque instance lit ses propres props (vue partagée par classe, pas les valeurs)", async () => {
        class Child extends Component {
            static template = xml`<i>{{ props.n }}</i>`;
            props = props({ n: t.number() });
        }
        class Parent extends Component {
            static template = xml`<p><Child n="1"/><Child n="2"/><Child t-foreach="[3, 4]" t-as="k" t-key="k" n="k"/></p>`;
            static components = { Child };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<p><i>1</i><i>2</i><i>3</i><i>4</i></p>");
    });

    test("deux classes différentes gardent chacune leur schéma", async () => {
        class A extends Component {
            static template = xml`<i>{{ props.x }}</i>`;
            props = props({ x: t.number().default(1) });
        }
        class B extends Component {
            static template = xml`<b>{{ props.x }}</b>`;
            props = props({ x: t.string().default("b") });
        }
        class Parent extends Component {
            static template = xml`<p><A/><B/></p>`;
            static components = { A, B };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<p><i>1</i><b>b</b></p>");
    });
});

describe("t-foreach : lignes ajoutées après le montage", () => {
    async function mutationsWhile(target: Node, fn: () => Promise<void>) {
        const records: MutationRecord[] = [];
        const observer = new MutationObserver((list) => records.push(...list));
        observer.observe(target, { childList: true, subtree: true });
        await fn();
        records.push(...observer.takeRecords());
        observer.disconnect();
        const added = records.flatMap((r) => Array.from(r.addedNodes));
        const removed = records.flatMap((r) => Array.from(r.removedNodes));
        return { added, removed };
    }

    test("sans donnée en attente : insérées directement, sans nœud provisoire", async () => {
        class C extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it }}</li></ul>`;
            @state accessor items = [1];
        }
        const { component, fixture, html } = await render(C);
        const { added, removed } = await mutationsWhile(fixture, async () => {
            component.items = [1, 2, 3, 4];
            await nextTick();
        });
        expect(html()).toBe("<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>");
        expect(removed).toEqual([]);
        expect(added.map((n) => n.nodeName)).toEqual(["LI", "LI", "LI"]);
    });

    test("l'index reste à jour après un réordonnancement", async () => {
        class C extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it }}:{{ it_index }}</li></ul>`;
            @state accessor items = ["a", "b", "c"];
        }
        const { component, html } = await render(C);
        component.items = ["c", "a", "b", "d"];
        await nextTick();
        expect(html()).toBe("<ul><li>c:0</li><li>a:1</li><li>b:2</li><li>d:3</li></ul>");
    });
});

describe("t-foreach : signal d'index seulement si x_index est lu", () => {
    test("le code généré ne demande l'index que s'il est utilisé", () => {
        const without = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it }}</li></ul>`.getCode();
        const withIndex = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it_index }}</li></ul>`.getCode();
        // Dernier argument de $h.each (après la localisation L<n>) : 1 si l'index est lu.
        expect(without).toMatch(/, L\d+, 0\);/);
        expect(withIndex).toMatch(/, L\d+, 1\);/);
    });
});
