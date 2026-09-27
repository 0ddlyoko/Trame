import { describe, expect, test } from "vitest";
import {
    Component,
    computed,
    effect,
    extendTemplate,
    inheritTemplate,
    nextTick,
    patch,
    Registry,
    registerTemplate,
    state,
    xml,
} from "../src/index";
import { Computed, Effect } from "../src/reactivity/core";
import { render } from "./helpers";

describe("patch()", () => {
    test("surcharge d'une méthode avec super, sur les instances existantes et futures", () => {
        class Greeter {
            greet(name: string) {
                return `Bonjour ${name}`;
            }
        }
        const before = new Greeter();
        const unpatch = patch(Greeter, {
            greet(name: string) {
                return `${super.greet(name)} !`;
            },
        });
        expect(before.greet("A")).toBe("Bonjour A !");
        expect(new Greeter().greet("B")).toBe("Bonjour B !");
        unpatch();
        expect(before.greet("A")).toBe("Bonjour A");
    });

    test("patchs empilés : chaque super appelle le précédent", () => {
        class Base {
            value() {
                return 1;
            }
        }
        patch(Base, {
            value() {
                return super.value() + 10;
            },
        });
        patch(Base, {
            value() {
                return super.value() * 2;
            },
        });
        expect(new Base().value()).toBe(22);
    });

    test("surcharge d'une méthode héritée d'une classe parente", () => {
        class A {
            name() {
                return "A";
            }
        }
        class B extends A {}
        patch(B, {
            name() {
                return `B<${super.name()}>`;
            },
        });
        expect(new B().name()).toBe("B<A>");
        expect(new A().name()).toBe("A");
    });

    test("classe de patch : nouveau champ @state et @computed surchargé avec super", async () => {
        class Line {
            @state accessor price = 10;
            @state accessor qty = 2;
            @computed get total() {
                return this.price * this.qty;
            }
        }
        patch(
            Line,
            class extends Line {
                @state accessor ecoTax = 1;
                @computed override get total() {
                    return super.total + this.ecoTax;
                }
            },
        );
        const line = new Line() as Line & { ecoTax: number };
        expect(line.total).toBe(21);
        const log: number[] = [];
        new Effect(() => void log.push(line.total), null).run();
        line.ecoTax = 5;
        await nextTick();
        line.qty = 3;
        await nextTick();
        expect(log).toEqual([21, 25, 35]);
    });

    test("patch d'un composant : champ, méthode et template étendu", async () => {
        class Counter extends Component {
            static template = xml`<div><span class="v">{{ count }}</span></div>`;
            @state accessor count = 1;
            increment() {
                this.count++;
            }
        }
        patch(
            Counter,
            class extends Counter {
                @state accessor step = 10;
                override increment() {
                    for (let i = 0; i < this.step; i++) {
                        super.increment();
                    }
                }
            },
        );
        extendTemplate(Counter, `<xpath expr="//span" position="after"><button t-on-click="increment">+{{ step }}</button></xpath>`);
        const { fixture } = await render(Counter);
        expect(fixture.innerHTML).toBe('<div><span class="v">1</span><button>+10</button></div>');
        fixture.querySelector("button")!.click();
        expect(fixture.querySelector(".v")!.textContent).toBe("11");
    });

    test("@effect ajouté par un patch", async () => {
        const log: string[] = [];
        class Widget extends Component {
            static template = xml`<p/>`;
        }
        patch(
            Widget,
            class extends Widget {
                @effect track() {
                    log.push("monté");
                }
            },
        );
        await render(Widget);
        expect(log).toEqual(["monté"]);
    });

    test("static components ajouté par un patch", async () => {
        class Extra extends Component {
            static template = xml`<em>extra</em>`;
        }
        class Host extends Component {
            static template = xml`<div/>`;
            static components = {};
        }
        patch(
            Host,
            class extends Host {
                static override components = { ...Host.components, Extra };
            },
        );
        extendTemplate(Host, `<div position="inside"><Extra/></div>`);
        const { html } = await render(Host);
        expect(html()).toBe("<div><em>extra</em></div>");
    });

    test("patch d'un objet", () => {
        const service = {
            format(v: number) {
                return `${v}`;
            },
        };
        patch(service, {
            format(v: number) {
                return `${super.format(v)} €`;
            },
        });
        expect(service.format(3)).toBe("3 €");
    });
});

describe("héritage de templates", () => {
    test("positions inside / before / after / replace / attributes", () => {
        const base = registerTemplate("ext.base", `<div class="card"><h1>Titre</h1><p name="body">corps</p></div>`);
        extendTemplate(
            "ext.base",
            `<t>
                <xpath expr="//h1" position="before"><span>avant</span></xpath>
                <xpath expr="//h1" position="after"><span>après</span></xpath>
                <xpath expr="/div" position="inside"><footer/></xpath>
                <p name="body" position="replace"><section>$0</section></p>
                <xpath expr="//div[hasclass('card')]" position="attributes">
                    <attribute name="class" add="big" remove="card"/>
                    <attribute name="title">Carte</attribute>
                </xpath>
            </t>`,
        );
        const code = base.getCode();
        expect(code).toContain('"span",0,["avant"]');
        const nodes = base.getNodes();
        const div = nodes[0] as { attrs: { name: string; value: string }[]; children: { tag?: string }[] };
        expect(div.attrs).toEqual([
            { name: "class", value: "big" },
            { name: "title", value: "Carte" },
        ]);
        expect(div.children.map((c) => c.tag)).toEqual(["span", "h1", "span", "section", "footer"]);
    });

    test("xpath : prédicats [n], [@attr='v'], contains, and", () => {
        const tpl = registerTemplate("ext.xpath", `<ul><li a="1">x</li><li a="2" b="yes">y</li><li a="3">z</li></ul>`);
        extendTemplate("ext.xpath", `<xpath expr="//li[2]" position="attributes"><attribute name="second">1</attribute></xpath>`);
        extendTemplate("ext.xpath", `<xpath expr="//li[@a='3']" position="attributes"><attribute name="third">1</attribute></xpath>`);
        extendTemplate("ext.xpath", `<xpath expr="//li[contains(@b, 'ye') and @a='2']" position="inside">!</xpath>`);
        const lis = (tpl.getNodes()[0] as { children: { attrs: { name: string }[]; children: { value?: string }[] }[] }).children;
        expect(lis[1].attrs.map((a) => a.name)).toContain("second");
        expect(lis[2].attrs.map((a) => a.name)).toContain("third");
        expect(lis[1].children.map((c) => c.value).join("")).toBe("y!");
    });

    test("cible introuvable : erreur explicite", () => {
        const tpl = registerTemplate("ext.missing", `<div/>`);
        extendTemplate("ext.missing", `<xpath expr="//table" position="inside"/>`);
        expect(() => tpl.getNodes()).toThrow(/aucun élément ne correspond à "\/\/table"/);
    });

    test("héritage primaire : nouveau template, l'original est intact", async () => {
        class Base extends Component {
            static template = xml`<div><h1>base</h1></div>`;
        }
        class Special extends Base {
            static override template = inheritTemplate(Base, `<xpath expr="//h1" position="replace"><h2>spécial</h2></xpath>`);
        }
        expect((await render(Base)).html()).toBe("<div><h1>base</h1></div>");
        expect((await render(Special)).html()).toBe("<div><h2>spécial</h2></div>");
    });
});

describe("Registry", () => {
    test("ajout, séquence, catégories, erreurs", () => {
        const reg = new Registry<string>("test");
        reg.add("b", "B").add("a", "A", { sequence: 10 }).add("c", "C", { sequence: 90 });
        expect(reg.getAll()).toEqual(["A", "B", "C"]);
        expect(reg.get("b")).toBe("B");
        expect(reg.get("zz", "défaut")).toBe("défaut");
        expect(() => reg.get("zz")).toThrow(/introuvable/);
        expect(() => reg.add("a", "X")).toThrow(/existe déjà/);
        reg.add("a", "X", { force: true });
        expect(reg.get("a")).toBe("X");
        reg.remove("b");
        expect(reg.getAll()).toEqual(["X", "C"]);
        expect(reg.category("fields")).toBe(reg.category("fields"));
    });

    test("réactif", async () => {
        const reg = new Registry<string>();
        const all = new Computed(() => reg.getAll().join(","));
        const log: string[] = [];
        new Effect(() => void log.push(all.get()), null).run();
        reg.add("x", "X");
        await nextTick();
        expect(log).toEqual(["", "X"]);
    });

    test("utilisé dans un template", async () => {
        const reg = new Registry<string>();
        class Menu extends Component {
            static template = xml`<ul><li t-foreach="items.getAll()" t-as="i" t-key="i">{{ i }}</li></ul>`;
            items = reg;
        }
        const { html } = await render(Menu);
        reg.add("ventes", "Ventes");
        await nextTick();
        expect(html()).toBe("<ul><li>Ventes</li></ul>");
    });
});
