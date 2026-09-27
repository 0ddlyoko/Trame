import { describe, expect, test, vi } from "vitest";
import {
    Component,
    effect,
    inject,
    mount,
    nextTick,
    props,
    provide,
    registerTemplate,
    state,
    t,
    xml,
} from "../../src/index";
import { render } from "../helpers";

describe("props", () => {
    test("props réactives : l'enfant suit le parent sans re-rendu du parent", async () => {
        const childRenders = vi.fn();
        class Child extends Component {
            static template = xml`<span>{{ props.value }}</span>`;
            props = props({ value: t.number() });
            constructor() {
                super();
                childRenders();
            }
        }
        class Parent extends Component {
            static template = xml`<div><Child value="count"/></div>`;
            static components = { Child };
            @state accessor count = 1;
        }
        const { html, component } = await render(Parent);
        expect(html()).toBe("<div><span>1</span></div>");
        component.count = 2;
        await nextTick();
        expect(html()).toBe("<div><span>2</span></div>");
        expect(childRenders).toHaveBeenCalledTimes(1);
    });

    test("valeurs par défaut et props facultatives", async () => {
        class Child extends Component {
            static template = xml`<span>{{ props.label }}-{{ props.size }}-{{ props.extra === undefined }}</span>`;
            props = props({
                label: t.string(),
                size: t.number().default(10),
                extra: t.string().optional(),
            });
        }
        class Parent extends Component {
            static template = xml`<Child label="'x'"/>`;
            static components = { Child };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<span>x-10-true</span>");
    });

    test("interpolation dans une prop", async () => {
        class Child extends Component {
            static template = xml`<span>{{ props.title }}</span>`;
            props = props({ title: t.string() });
        }
        class Parent extends Component {
            static template = xml`<Child title="Commande {{ n }}"/>`;
            static components = { Child };
            n = 7;
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<span>Commande 7</span>");
    });

    test("mode dev : prop de mauvais type, manquante ou inconnue", async () => {
        class Child extends Component {
            static template = xml`<span/>`;
            props = props({ id: t.number() });
        }
        class Wrong extends Component {
            static template = xml`<Child id="'abc'"/>`;
            static components = { Child };
        }
        class Missing extends Component {
            static template = xml`<Child/>`;
            static components = { Child };
        }
        class Unknown extends Component {
            static template = xml`<Child id="1" idd="2"/>`;
            static components = { Child };
        }
        await expect(render(Wrong)).rejects.toThrow(/Prop "id" invalide pour Child : number attendu/);
        await expect(render(Missing)).rejects.toThrow(/Prop obligatoire "id" manquante/);
        await expect(render(Unknown)).rejects.toThrow(/Prop inconnue "idd"/);
    });

    test("validateurs : array, object, instanceOf, literal, or, orNull", async () => {
        class Item {}
        const schema = {
            a: t.array(t.number()),
            b: t.object({ x: t.string() }),
            c: t.instanceOf(Item),
            d: t.literal("draft", "done"),
            e: t.or(t.string(), t.number()),
            f: t.string().orNull(),
        };
        expect(schema.a.check([1, 2])).toBeNull();
        expect(schema.a.check([1, "2"])).toMatch(/\[1\]/);
        expect(schema.b.check({ x: "y" })).toBeNull();
        expect(schema.b.check({ x: 1 })).toMatch(/\.x/);
        expect(schema.c.check(new Item())).toBeNull();
        expect(schema.c.check({})).not.toBeNull();
        expect(schema.d.check("done")).toBeNull();
        expect(schema.d.check("other")).not.toBeNull();
        expect(schema.e.check(1)).toBeNull();
        expect(schema.e.check(true)).not.toBeNull();
        expect(schema.f.check(null)).toBeNull();
    });

    test("l'objet props lui-même n'est pas modifiable (dev et prod)", async () => {
        for (const dev of [true, false]) {
            const errors: unknown[] = [];
            class Child extends Component {
                static template = xml`<button t-on-click="mutate">x</button>`;
                props = props({ value: t.number() });
                mutate() {
                    (this.props as { value: number }).value = 5;
                }
            }
            class Parent extends Component {
                static template = xml`<Child value="1"/>`;
                static components = { Child };
            }
            const { fixture, destroy } = await render(Parent, { dev, onError: (e) => errors.push(e) });
            fixture.querySelector("button")!.click();
            expect(String(errors[0])).toMatch(/lecture seule/);
            destroy();
        }
    });

    test("callback vers le parent (les données descendent, les actions remontent)", async () => {
        class Child extends Component {
            static template = xml`<button t-on-click="() => props.onPick(props.value * 2)">x</button>`;
            props = props({ value: t.number(), onPick: t.func<(v: number) => void>() });
        }
        class Parent extends Component {
            static template = xml`<div><Child value="3" onPick="(v) => picked = v"/><p>{{ picked }}</p></div>`;
            static components = { Child };
            @state accessor picked = 0;
        }
        const { fixture } = await render(Parent);
        fixture.querySelector("button")!.click();
        expect(fixture.querySelector("p")!.textContent).toBe("6");
    });

    test("t-props : props passées en bloc", async () => {
        class Child extends Component {
            static template = xml`<span>{{ props.a }}{{ props.b }}</span>`;
            props = props({ a: t.number(), b: t.number() });
        }
        class Parent extends Component {
            static template = xml`<Child t-props="p" b="9"/>`;
            static components = { Child };
            p = { a: 1 };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<span>19</span>");
    });

    test("composant non déclaré : erreur explicite", async () => {
        class Parent extends Component {
            static template = xml`<Unknown/>`;
        }
        await expect(render(Parent)).rejects.toThrow(/Composant <Unknown> introuvable/);
    });

    test("un composant ne peut pas être créé avec new", () => {
        class Foo extends Component {}
        expect(() => new Foo()).toThrow(/mount\(\)/);
    });
});

describe("slots", () => {
    test("slot par défaut, slots nommés, contenu par défaut", async () => {
        class Card extends Component {
            static template = xml`
                <div class="card">
                    <header><t t-slot="header">Titre par défaut</t></header>
                    <main><t t-slot="default"/></main>
                    <footer><t t-slot="footer">rien</t></footer>
                </div>`;
        }
        class Page extends Component {
            static template = xml`
                <Card>
                    <t t-set-slot="header"><h1>{{ title }}</h1></t>
                    <p>Contenu {{ title }}</p>
                </Card>`;
            static components = { Card };
            @state accessor title = "A";
        }
        const { html, component } = await render(Page);
        expect(html()).toBe('<div class="card"><header><h1>A</h1></header><main><p>Contenu A</p></main><footer>rien</footer></div>');
        component.title = "B";
        await nextTick();
        expect(html()).toContain("<h1>B</h1>");
        expect(html()).toContain("<p>Contenu B</p>");
    });

    test("slot avec portée (t-slot-scope)", async () => {
        class List extends Component {
            static template = xml`<ul><li t-foreach="props.items" t-as="item" t-key="item"><t t-slot="default" value="item" upper="item.toUpperCase()"/></li></ul>`;
            props = props({ items: t.array(t.string()) });
        }
        class Page extends Component {
            static template = xml`<List items="items" t-slot-scope="s"><b>{{ s.value }}/{{ s.upper }}</b></List>`;
            static components = { List };
            items = ["a", "b"];
        }
        const { html } = await render(Page);
        expect(html()).toBe("<ul><li><b>a/A</b></li><li><b>b/B</b></li></ul>");
    });
});

describe("composants dynamiques et t-call", () => {
    test("t-component", async () => {
        class A extends Component {
            static template = xml`<i>A</i>`;
        }
        class B extends Component {
            static template = xml`<b>B</b>`;
        }
        class Host extends Component {
            static template = xml`<div><t t-component="current"/></div>`;
            @state accessor current: typeof A | typeof B = A;
        }
        const { html, component } = await render(Host);
        expect(html()).toBe("<div><i>A</i></div>");
        component.current = B;
        await nextTick();
        expect(html()).toBe("<div><b>B</b></div>");
    });

    test("t-call avec paramètres", async () => {
        registerTemplate("test.badge", `<span class="badge">{{ label }}:{{ count }}</span>`);
        class Host extends Component {
            static template = xml`<div><t t-call="test.badge" label="'Lignes'"/></div>`;
            count = 3;
        }
        const { html } = await render(Host);
        expect(html()).toBe('<div><span class="badge">Lignes:3</span></div>');
    });

    test("template nommé comme template de composant", async () => {
        registerTemplate("test.named", `<p>{{ v }}</p>`);
        class Named extends Component {
            static template = "test.named";
            v = "ok";
        }
        const { html } = await render(Named);
        expect(html()).toBe("<p>ok</p>");
    });
});

describe("services : @provide / @inject", () => {
    test("service d'application (classe instanciée à la demande, une seule fois)", async () => {
        const created = vi.fn();
        class Rpc {
            constructor() {
                created();
            }
            call() {
                return "pong";
            }
        }
        class Child extends Component {
            static template = xml`<span>{{ rpc.call() }}</span>`;
            @inject(Rpc) rpc!: Rpc;
        }
        class Parent extends Component {
            static template = xml`<div><Child/><Child/></div>`;
            static components = { Child };
        }
        const { html } = await render(Parent, { provide: [Rpc] });
        expect(html()).toBe("<div><span>pong</span><span>pong</span></div>");
        expect(created).toHaveBeenCalledTimes(1);
    });

    test("service fourni par un ancêtre, sans passer par les niveaux intermédiaires", async () => {
        class Editor {
            @state accessor value = 0;
            update(v: number) {
                this.value = v;
            }
        }
        class Field extends Component {
            static template = xml`<button t-on-click="() => editor.update(editor.value + 1)">{{ editor.value }}</button>`;
            @inject(Editor) editor!: Editor;
        }
        class Group extends Component {
            static template = xml`<section><Field/></section>`;
            static components = { Field };
        }
        class Form extends Component {
            static template = xml`<div><Group/><p>{{ editor.value }}</p></div>`;
            static components = { Group };
            @provide editor = new Editor();
        }
        const { fixture } = await render(Form);
        fixture.querySelector("button")!.click();
        expect(fixture.querySelector("button")!.textContent).toBe("1");
        expect(fixture.querySelector("p")!.textContent).toBe("1");
    });

    test("un service peut injecter un autre service", async () => {
        class Config {
            url = "/api";
        }
        class Rpc {
            @inject(Config) config!: Config;
        }
        class Comp extends Component {
            static template = xml`<span>{{ rpc.config.url }}</span>`;
            @inject(Rpc) rpc!: Rpc;
        }
        const { html } = await render(Comp, { provide: [Config, Rpc] });
        expect(html()).toBe("<span>/api</span>");
    });

    test("injection d'une classe parente : trouve l'instance fournie de la sous-classe", async () => {
        class Base {
            name = "base";
        }
        class Special extends Base {
            override name = "special";
        }
        class Comp extends Component {
            static template = xml`<span>{{ svc.name }}</span>`;
            @inject(Base) svc!: Base;
        }
        const { html } = await render(Comp, { provide: [new Special()] });
        expect(html()).toBe("<span>special</span>");
    });

    test("service manquant : erreur explicite", async () => {
        class Missing {}
        class Comp extends Component {
            static template = xml`<span/>`;
            @inject(Missing) m!: Missing;
        }
        await expect(render(Comp)).rejects.toThrow(/Aucun service Missing/);
    });
});

describe("cycle de vie : @effect et destruction", () => {
    test("@effect s'exécute après le montage, se réexécute, se nettoie à la destruction", async () => {
        const log: string[] = [];
        class Comp extends Component {
            static template = xml`<canvas t-ref="canvas"/>`;
            @state accessor canvas: HTMLCanvasElement | null = null;
            @state accessor period = "month";
            @effect draw() {
                const inDom = document.body.contains(this.canvas);
                log.push(`draw ${this.period} ${inDom}`);
                return () => log.push(`clean ${this.period}`);
            }
        }
        const { root, component } = await render(Comp);
        expect(log).toEqual(["draw month true"]);
        component.period = "year";
        await nextTick();
        expect(log).toEqual(["draw month true", "clean year", "draw year true"]);
        root.destroy();
        expect(log[log.length - 1]).toBe("clean year");
    });

    test("les enfants sont montés avant les parents", async () => {
        const log: string[] = [];
        class Child extends Component {
            static template = xml`<i/>`;
            @effect mounted() {
                log.push("child");
            }
        }
        class Parent extends Component {
            static template = xml`<div><Child/></div>`;
            static components = { Child };
            @effect mounted() {
                log.push("parent");
            }
        }
        await render(Parent);
        expect(log).toEqual(["child", "parent"]);
    });

    test("destroy retire le DOM et arrête les mises à jour", async () => {
        class Comp extends Component {
            static template = xml`<p>{{ n }}</p>`;
            @state accessor n = 1;
        }
        const { root, fixture, component } = await render(Comp);
        root.destroy();
        expect(fixture.innerHTML).toBe("");
        component.n = 2;
        await nextTick();
        expect(fixture.innerHTML).toBe("");
    });

    test("un composant retiré par un t-if est détruit (effets nettoyés)", async () => {
        const cleaned = vi.fn();
        class Child extends Component {
            static template = xml`<i/>`;
            @effect e() {
                return cleaned;
            }
        }
        class Parent extends Component {
            static template = xml`<div><Child t-if="show"/></div>`;
            static components = { Child };
            @state accessor show = true;
        }
        const { component } = await render(Parent);
        component.show = false;
        await nextTick();
        expect(cleaned).toHaveBeenCalledTimes(1);
    });

    test("erreur à la construction : mount est rejeté", async () => {
        class Broken extends Component {
            static template = xml`<p/>`;
            constructor() {
                super();
                throw new Error("cassé");
            }
        }
        const fixture = document.createElement("div");
        await expect(mount(Broken, fixture)).rejects.toThrow("cassé");
        expect(fixture.innerHTML).toBe("");
    });
});
