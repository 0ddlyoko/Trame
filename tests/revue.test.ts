// Non-régression : points soulevés par la revue de code (un bloc describe par point).
import { describe, expect, test } from "vitest";
import { Component, extendTemplate, inheritTemplate, props, state, t, xml } from "../src/index";
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
