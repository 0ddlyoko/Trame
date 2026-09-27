import { describe, expect, test } from "vitest";
import { Component, markup, nextTick, state, xml } from "../../src/index";
import { longestIncreasingSubsequence } from "../../src/runtime/regions";
import { render } from "../helpers";

describe("t-if / t-elif / t-else", () => {
    test("bascule entre les branches", async () => {
        class Cond extends Component {
            static template = xml`
                <div>
                    <p t-if="n === 0">zéro</p>
                    <p t-elif="n === 1">un</p>
                    <p t-else="">beaucoup</p>
                </div>`;
            @state accessor n = 0;
        }
        const { html, component } = await render(Cond);
        expect(html()).toBe("<div><p>zéro</p></div>");
        component.n = 1;
        await nextTick();
        expect(html()).toBe("<div><p>un</p></div>");
        component.n = 5;
        await nextTick();
        expect(html()).toBe("<div><p>beaucoup</p></div>");
    });

    test("sans t-else : rien n'est affiché", async () => {
        class Cond extends Component {
            static template = xml`<div><span t-if="show">x</span></div>`;
            @state accessor show = false;
        }
        const { html, component } = await render(Cond);
        expect(html()).toBe("<div></div>");
        component.show = true;
        await nextTick();
        expect(html()).toBe("<div><span>x</span></div>");
    });

    test("t-if à la racine du template et sur <t>", async () => {
        class Root extends Component {
            static template = xml`<t t-if="show"><b>a</b><i>b</i></t>`;
            @state accessor show = true;
        }
        const { html, component } = await render(Root);
        expect(html()).toBe("<b>a</b><i>b</i>");
        component.show = false;
        await nextTick();
        expect(html()).toBe("");
        component.show = true;
        await nextTick();
        expect(html()).toBe("<b>a</b><i>b</i>");
    });

    test("un enfant n'est pas réévalué avec un état incohérent (parent d'abord)", async () => {
        class Guard extends Component {
            static template = xml`<div><p t-if="order">{{ order.name }}</p></div>`;
            @state accessor order: { name: string } | null = { name: "SO1" };
        }
        const { html, component } = await render(Guard);
        component.order = null;
        await nextTick();
        expect(html()).toBe("<div></div>");
    });

    test("le contenu d'une branche garde son état tant que la condition ne bascule pas", async () => {
        class Keep extends Component {
            static template = xml`<div><input t-if="show"/><span>{{ other }}</span></div>`;
            @state accessor show = true;
            @state accessor other = 1;
        }
        const { fixture, component } = await render(Keep);
        const input = fixture.querySelector("input")!;
        component.other = 2;
        await nextTick();
        expect(fixture.querySelector("input")).toBe(input);
    });
});

describe("t-foreach", () => {
    test("liste simple avec t-key, index", async () => {
        class List extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="item" t-key="item.id">{{ item_index }}:{{ item.name }}</li></ul>`;
            @state accessor items = [
                { id: 1, name: "a" },
                { id: 2, name: "b" },
            ];
        }
        const { html } = await render(List);
        expect(html()).toBe("<ul><li>0:a</li><li>1:b</li></ul>");
    });

    test("ajout, suppression, mise à jour d'un élément (réactivité profonde)", async () => {
        class List extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="item" t-key="item.id">{{ item.name }}</li></ul>`;
            @state accessor items = [
                { id: 1, name: "a" },
                { id: 2, name: "b" },
            ];
        }
        const { html, component, fixture } = await render(List);
        const first = fixture.querySelector("li");
        component.items.push({ id: 3, name: "c" });
        await nextTick();
        expect(html()).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
        component.items[0].name = "A";
        await nextTick();
        expect(html()).toBe("<ul><li>A</li><li>b</li><li>c</li></ul>");
        expect(fixture.querySelector("li")).toBe(first);
        component.items.splice(1, 1);
        await nextTick();
        expect(html()).toBe("<ul><li>A</li><li>c</li></ul>");
        component.items = [];
        await nextTick();
        expect(html()).toBe("<ul></ul>");
    });

    test("réordonnancement : les nœuds DOM sont réutilisés", async () => {
        class List extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="n" t-key="n">{{ n }}</li></ul>`;
            @state accessor items = [1, 2, 3, 4, 5];
        }
        const { fixture, component } = await render(List);
        const nodes = Array.from(fixture.querySelectorAll("li"));
        component.items = [5, 1, 2, 3, 4];
        await nextTick();
        const after = Array.from(fixture.querySelectorAll("li"));
        expect(after.map((li) => li.textContent)).toEqual(["5", "1", "2", "3", "4"]);
        expect(after[0]).toBe(nodes[4]);
        expect(after[1]).toBe(nodes[0]);
        component.items = [4, 3, 2, 1];
        await nextTick();
        expect(Array.from(fixture.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["4", "3", "2", "1"]);
        expect(fixture.querySelectorAll("li")[0]).toBe(nodes[3]);
    });

    test("un seul déplacement DOM pour une rotation (plus longue sous-suite croissante)", async () => {
        class List extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="n" t-key="n">{{ n }}</li></ul>`;
            @state accessor items = [1, 2, 3, 4, 5, 6];
        }
        const { fixture, component } = await render(List);
        const ul = fixture.querySelector("ul")!;
        let moves = 0;
        const original = ul.insertBefore.bind(ul);
        ul.insertBefore = ((node: Node, ref: Node | null) => {
            moves++;
            return original(node, ref);
        }) as typeof ul.insertBefore;
        component.items = [6, 1, 2, 3, 4, 5];
        await nextTick();
        expect(moves).toBe(1);
    });

    test("échange de deux éléments hors batch : pas d'état intermédiaire (clé en double)", async () => {
        class List extends Component {
            static template = xml`<p><t t-foreach="items" t-as="x" t-key="x.id">{{ x.id }}</t></p>`;
            @state accessor items = [{ id: 1 }, { id: 2 }, { id: 3 }];
        }
        const { html, component } = await render(List);
        const rows = component.items;
        const a = rows[0];
        rows[0] = rows[2];
        rows[2] = a;
        await nextTick();
        expect(html()).toBe("<p>321</p>");
    });

    test("sans t-key : la clé est l'élément lui-même", async () => {
        class List extends Component {
            static template = xml`<p><t t-foreach="items" t-as="x">{{ x }},</t></p>`;
            @state accessor items = ["a", "b"];
        }
        const { html, component } = await render(List);
        expect(html()).toBe("<p>a,b,</p>");
        component.items = ["b", "c", "a"];
        await nextTick();
        expect(html()).toBe("<p>b,c,a,</p>");
    });

    test("clé en double : erreur explicite", async () => {
        class List extends Component {
            static template = xml`<p><t t-foreach="items" t-as="x" t-key="x.id">.</t></p>`;
            items = [{ id: 1 }, { id: 1 }];
        }
        await expect(render(List)).rejects.toThrow(/clé en double/);
    });

    test("boucles imbriquées et t-if dans une boucle", async () => {
        class Nested extends Component {
            static template = xml`
                <div>
                    <p t-foreach="groups" t-as="g" t-key="g.name">
                        {{ g.name }}:<t t-foreach="g.items" t-as="i" t-key="i"><b t-if="i % 2">{{ i }}</b></t>
                    </p>
                </div>`;
            groups = [
                { name: "x", items: [1, 2, 3] },
                { name: "y", items: [4, 5] },
            ];
        }
        const { html } = await render(Nested);
        expect(html()).toBe("<div><p> x:<b>1</b><b>3</b></p><p> y:<b>5</b></p></div>");
    });

    test("t-foreach sur un nombre et sur un objet", async () => {
        class Range extends Component {
            static template = xml`<p><t t-foreach="3" t-as="i">{{ i }}</t>|<t t-foreach="obj" t-as="v">{{ v }}</t></p>`;
            obj = { a: 1, b: 2 };
        }
        const { html } = await render(Range);
        expect(html()).toBe("<p>012|12</p>");
    });

    test("l'élément de boucle est réactif si l'objet change pour la même clé", async () => {
        class List extends Component {
            static template = xml`<p><t t-foreach="items" t-as="x" t-key="x.id">{{ x.v }}</t></p>`;
            @state accessor items = [{ id: 1, v: "a" }];
        }
        const { html, component } = await render(List);
        component.items = [{ id: 1, v: "b" }];
        await nextTick();
        expect(html()).toBe("<p>b</p>");
    });
});

describe("t-set et t-out", () => {
    test("t-set est réactif et visible des frères suivants", async () => {
        class WithSet extends Component {
            static template = xml`<div><t t-set="double" t-value="n * 2"/><p>{{ double }}</p></div>`;
            @state accessor n = 2;
        }
        const { html, component } = await render(WithSet);
        expect(html()).toBe("<div><p>4</p></div>");
        component.n = 5;
        await nextTick();
        expect(html()).toBe("<div><p>10</p></div>");
    });

    test("t-out : texte, markup, changement", async () => {
        class Out extends Component {
            static template = xml`<div><t t-out="value"/></div>`;
            @state accessor value: unknown = "a<b";
        }
        const { html, component } = await render(Out);
        expect(html()).toBe("<div>a&lt;b</div>");
        component.value = markup("<i>x</i><i>y</i>");
        await nextTick();
        expect(html()).toBe("<div><i>x</i><i>y</i></div>");
        component.value = null;
        await nextTick();
        expect(html()).toBe("<div></div>");
    });
});

describe("longestIncreasingSubsequence", () => {
    test("indices de la sous-suite", () => {
        expect(longestIncreasingSubsequence([5, 0, 1, 2, 3, 4])).toEqual([1, 2, 3, 4, 5]);
        expect(longestIncreasingSubsequence([-1, 2, -1, 0, 1])).toEqual([3, 4]);
        expect(longestIncreasingSubsequence([])).toEqual([]);
    });
});
