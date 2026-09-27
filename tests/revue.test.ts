// Non-régression : points soulevés par la revue de code (un bloc describe par point).
import { describe, expect, test } from "vitest";
import { Component, effect, extendTemplate, inheritTemplate, load, props, resource, state, t, xml } from "../src/index";
import { nextTick } from "../src/index";
import { render, settle } from "./helpers";

describe("gestionnaires d'événements : erreurs asynchrones", () => {
    const forms = [
        ["méthode", `t-on-click="save"`],
        ["appel avec argument", `t-on-click="save(1)"`],
        ["fonction fléchée", `t-on-click="(ev) => save(ev)"`],
        ["fonction fléchée à bloc", `t-on-click="(ev) => { return save(ev); }"`],
        ["instruction suivie d'un appel", `t-on-click="count = count + 1, save(count)"`],
    ] as const;

    for (const [label, attr] of forms) {
        test(`${label} : le rejet de la promesse atteint l'<ErrorBoundary>`, async () => {
            class Child extends Component {
                static template = xml`<button ${attr}>x</button>`;
                @state accessor count = 0;
                async save(_arg?: unknown) {
                    throw new Error("échec de l'enregistrement");
                }
            }
            class Parent extends Component {
                static template = xml`<div><ErrorBoundary><t t-set-slot="fallback" t-slot-scope="e">KO {{ e.error.message }}</t><Child/></ErrorBoundary></div>`;
                static components = { Child };
            }
            const { fixture, html } = await render(Parent);
            (fixture.querySelector("button") as HTMLButtonElement).click();
            await settle();
            expect(html()).toBe("<div>KO échec de l'enregistrement</div>");
        });
    }
});

describe("props : même objet en dev et en prod (pas de Proxy de lecture seule)", () => {
    for (const dev of [true, false]) {
        const mode = dev ? "dev" : "prod";

        test(`${mode} : l'enfant reçoit l'objet même du parent (identité conservée)`, async () => {
            class Line {
                price = 1;
            }
            let received: unknown;
            class Child extends Component {
                static template = xml`<span>{{ props.line.price }}</span>`;
                props = props({ line: t.instanceOf(Line), lines: t.array() });
                constructor() {
                    super();
                    received = this.props.line;
                }
            }
            class Parent extends Component {
                static template = xml`<Child line="lines[0]" lines="lines"/>`;
                static components = { Child };
                lines = [new Line()];
            }
            const { component } = await render(Parent, { dev });
            expect(received).toBe(component.lines[0]);
        });

        test(`${mode} : une Map et un Set passés en props sont utilisables`, async () => {
            class Child extends Component {
                static template = xml`<span>{{ props.m.get("a") }}-{{ props.s.has(2) }}-{{ props.m.size }}</span>`;
                props = props({ m: t.instanceOf(Map), s: t.instanceOf(Set) });
            }
            class Parent extends Component {
                static template = xml`<Child m="m" s="s"/>`;
                static components = { Child };
                m = new Map([["a", 1]]);
                s = new Set([2]);
            }
            const { html } = await render(Parent, { dev });
            expect(html()).toBe("<span>1-true-1</span>");
        });

        test(`${mode} : une méthode qui lit un champ #privé fonctionne`, async () => {
            class Money {
                #cents = 1234;
                label() {
                    return (this.#cents / 100).toFixed(2);
                }
            }
            class Child extends Component {
                static template = xml`<span>{{ props.amount.label() }}</span>`;
                props = props({ amount: t.instanceOf(Money) });
            }
            class Parent extends Component {
                static template = xml`<Child amount="amount"/>`;
                static components = { Child };
                amount = new Money();
            }
            const { html } = await render(Parent, { dev });
            expect(html()).toBe("<span>12.34</span>");
        });
    }
});

describe("expressions : vrai parseur (portées JavaScript)", () => {
    test("variables et fonctions déclarées dans un gestionnaire", async () => {
        class C extends Component {
            static template = xml`<div>
                <button t-on-click="() => { const step = 2; let total = 0; for (const n of [1, 2]) { total += n * step; } count = total; }">+</button>
                <span>{{ count }}</span>
                <ul><li t-foreach="items.filter(function (it) { return it.ok; })" t-as="it" t-key="it.id">{{ it.id }}</li></ul>
            </div>`;
            @state accessor count = 0;
            items = [
                { id: 1, ok: true },
                { id: 2, ok: false },
            ];
        }
        const { fixture } = await render(C);
        (fixture.querySelector("button") as HTMLButtonElement).click();
        expect(fixture.querySelector("span")!.textContent).toBe("6");
        expect(fixture.querySelector("ul")!.innerHTML).toBe("<li>1</li>");
    });

    test("une erreur de syntaxe indique le template et l'expression", async () => {
        class C extends Component {
            static template = xml`<div>{{ a + }}</div>`;
        }
        await expect(render(C)).rejects.toThrow(/template "C".*a \+/s);
    });
});

describe("héritage de templates : une extension de la base atteint les dérivés déjà compilés", () => {
    test("inheritTemplate, sur deux niveaux", async () => {
        class Base extends Component {
            static template = xml`<div><h1>base</h1></div>`;
        }
        class Derived extends Component {
            static template = inheritTemplate(Base, `<xpath expr="//h1" position="after"><p>dérivé</p></xpath>`);
        }
        class Derived2 extends Component {
            static template = inheritTemplate(Derived, `<xpath expr="//p" position="after"><span>2</span></xpath>`);
        }
        expect((await render(Derived)).html()).toBe("<div><h1>base</h1><p>dérivé</p></div>");
        expect((await render(Derived2)).html()).toBe("<div><h1>base</h1><p>dérivé</p><span>2</span></div>");

        extendTemplate(Base, `<xpath expr="//h1" position="before"><i>ext</i></xpath>`);
        expect((await render(Base)).html()).toBe("<div><i>ext</i><h1>base</h1></div>");
        expect((await render(Derived)).html()).toBe("<div><i>ext</i><h1>base</h1><p>dérivé</p></div>");
        expect((await render(Derived2)).html()).toBe("<div><i>ext</i><h1>base</h1><p>dérivé</p><span>2</span></div>");
    });
});

describe("objets créés après la construction : rattachés au bon scope", () => {
    /** Modèle avec une requête qui ne se termine jamais et un effet : on observe leur nettoyage. */
    function makeModel(log: string[]) {
        let n = 0;
        return class Model {
            readonly id = ++n;
            @state accessor tick = 0;
            @resource accessor data = load(({ signal }) => {
                signal.addEventListener("abort", () => log.push(`abort ${this.id}`));
                return new Promise<number>(() => {});
            });
            @effect watch() {
                void this.tick;
                log.push(`effet ${this.id}`);
                return () => log.push(`nettoyage ${this.id}`);
            }
        };
    }

    test("créé dans un gestionnaire d'événement : nettoyé à la destruction du composant", async () => {
        const log: string[] = [];
        const Model = makeModel(log);
        class C extends Component {
            static template = xml`<button t-on-click="make">+</button>`;
            model: InstanceType<typeof Model> | null = null;
            make() {
                this.model = new Model();
                void this.model.data;
            }
        }
        const r = await render(C);
        (r.fixture.querySelector("button") as HTMLButtonElement).click();
        await settle();
        expect(log).toEqual(["effet 1"]);
        r.destroy();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1"]);
        // L'effet du modèle ne tourne plus après la destruction.
        r.component.model!.tick++;
        await settle();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1"]);
    });

    test("créé dans un @effect : nettoyé à chaque nouvelle exécution de l'effet et à la destruction", async () => {
        const log: string[] = [];
        const Model = makeModel(log);
        class C extends Component {
            static template = xml`<p>{{ n }}</p>`;
            @state accessor n = 0;
            @effect create() {
                void this.n;
                const model = new Model();
                void model.data;
            }
        }
        const r = await render(C);
        await settle();
        expect(log).toEqual(["effet 1"]);
        r.component.n++;
        await settle();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1", "effet 2"]);
        r.destroy();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1", "effet 2", "nettoyage 2", "abort 2"]);
    });
});

describe("t-foreach sans t-key : valeurs en double acceptées", () => {
    test("primitives en double, puis réordonnées", async () => {
        class C extends Component {
            static template = xml`<p><span t-foreach="tags" t-as="tag">{{ tag }}{{ tag_index }}</span></p>`;
            @state accessor tags = ["a", "a", "b"];
        }
        const { component, html } = await render(C);
        expect(html()).toBe("<p><span>a0</span><span>a1</span><span>b2</span></p>");
        component.tags = ["b", "a", "a", "a"];
        await nextTick();
        expect(html()).toBe("<p><span>b0</span><span>a1</span><span>a2</span><span>a3</span></p>");
        component.tags = ["a"];
        await nextTick();
        expect(html()).toBe("<p><span>a0</span></p>");
    });

    test("un même objet présent deux fois : les lignes existantes sont conservées", async () => {
        const x = { v: "x" };
        const y = { v: "y" };
        class C extends Component {
            static template = xml`<p><span t-foreach="items" t-as="it">{{ it.v }}</span></p>`;
            @state accessor items = [x, x, y];
        }
        const { component, fixture, html } = await render(C);
        const spans = Array.from(fixture.querySelectorAll("span"));
        component.items = [y, x, x];
        await nextTick();
        expect(html()).toBe("<p><span>y</span><span>x</span><span>x</span></p>");
        const after = Array.from(fixture.querySelectorAll("span"));
        expect(after[0]).toBe(spans[2]);
        expect(after.slice(1)).toEqual(spans.slice(0, 2));
    });
});

describe("macros loading / error / refresh et membres du composant", () => {
    test("une méthode du composant portant le nom d'une macro l'emporte", async () => {
        const calls: unknown[] = [];
        class C extends Component {
            static template = xml`<button t-on-click="refresh(42)">x</button>`;
            refresh(id: number) {
                calls.push(id);
            }
        }
        const { fixture } = await render(C);
        (fixture.querySelector("button") as HTMLButtonElement).click();
        expect(calls).toEqual([42]);
    });

    test("un champ (non fonction) portant le nom d'une macro laisse la macro fonctionner", async () => {
        let resolve!: (v: string) => void;
        class C extends Component {
            static template = xml`<div><p>{{ loading(data) ? "chargement" : "prêt" }}</p><i>{{ loading }}</i></div>`;
            @state accessor loading = "champ";
            @resource accessor data = load(() => new Promise<string>((r) => (resolve = r)), { eager: true });
        }
        const { html } = await render(C);
        expect(html()).toBe("<div><p>chargement</p><i>champ</i></div>");
        resolve("ok");
        await settle();
        expect(html()).toBe("<div><p>prêt</p><i>champ</i></div>");
    });
});
