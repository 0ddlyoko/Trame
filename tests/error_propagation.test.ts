// Une erreur levée pendant le montage d'un composant remonte jusqu'à l'<ErrorBoundary> la plus
// proche (ou, à défaut, jusqu'au premier gestionnaire : onError, ou le rejet de mount()).
import { describe, expect, test } from "vitest";
import { Component, type ComponentClass, computed, effect, load, mount, nextTick, props, registerTemplate, resource, state, t, xml } from "../src/index";
import { render, settle } from "./helpers";

const FALLBACK = `<t t-set-slot="fallback" t-slot-scope="e">KO {{ e.error.message }}</t>`;

class Boom extends Component {
    static template = xml`<b>jamais affiché</b>`;
    constructor() {
        super();
        throw new Error("constructeur");
    }
}

describe("erreur au montage : interceptée par l'<ErrorBoundary> la plus proche", () => {
    const cases: [string, () => Record<string, ComponentClass>, string][] = [
        ["constructeur d'un enfant profond", () => ({ Boom, Mid: mid(`<Boom/>`, { Boom }) }), `<Mid/>`],
        [
            "props invalides (mode dev)",
            () => ({
                Child: class extends Component {
                    static template = xml`<i/>`;
                    props = props({ n: t.number() });
                },
            }),
            `<Child n="'texte'"/>`,
        ],
        [
            "@effect qui échoue au montage",
            () => ({
                Child: class extends Component {
                    static template = xml`<i/>`;
                    @effect start() {
                        throw new Error("effet");
                    }
                },
            }),
            `<Child/>`,
        ],
        [
            "liaison du template qui échoue",
            () => ({
                Child: class extends Component {
                    static template = xml`<i>{{ missing.value }}</i>`;
                    missing: { value: number } | null = null;
                },
            }),
            `<Child/>`,
        ],
        [
            "@computed qui échoue",
            () => ({
                Child: class extends Component {
                    static template = xml`<i>{{ total }}</i>`;
                    @computed get total(): number {
                        throw new Error("calcul");
                    }
                },
            }),
            `<Child/>`,
        ],
        [
            "template de l'enfant invalide",
            () => ({
                Child: class extends Component {
                    static template = xml`<i>{{ a + }}</i>`;
                },
            }),
            `<Child/>`,
        ],
        [
            "premier chargement d'une donnée qui échoue",
            () => ({
                Child: class extends Component {
                    static template = xml`<i>{{ data }}</i>`;
                    @resource accessor data = load(async () => {
                        throw new Error("404");
                    });
                },
            }),
            `<Child/>`,
        ],
        ["composant dans le slot d'un autre", () => ({ Boom, Card: mid(`<div><t t-slot="default"/></div>`, {}) }), `<Card><Boom/></Card>`],
        ["composant dynamique (t-component)", () => ({ Boom }), `<t t-component="dyn"/>`],
        ["composant dans une ligne de t-foreach", () => ({ Boom }), `<t t-foreach="[1]" t-as="i" t-key="i"><Boom/></t>`],
        ["composant dans un <Suspense>", () => ({ Boom }), `<Suspense><Boom/></Suspense>`],
    ];

    for (const [label, components, inner] of cases) {
        test(label, async () => {
            class Parent extends Component {
                static template = xml`<div><p>avant</p><ErrorBoundary>${FALLBACK}${inner}</ErrorBoundary><p>après</p></div>`;
                static components = components();
                dyn = Boom;
            }
            const { html } = await render(Parent);
            await settle();
            expect(html()).toMatch(/^<div><p>avant<\/p>KO .+<p>après<\/p><\/div>$/);
        });
    }

    test("t-call : erreur dans le template appelé", async () => {
        registerTemplate("err.called", `<i>{{ nothing.x }}</i>`);
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary>${FALLBACK}<t t-call="err.called"/></ErrorBoundary></div>`;
            nothing: { x: number } | null = null;
        }
        const { html } = await render(Parent);
        expect(html()).toMatch(/^<div>KO /);
    });
});

describe("erreur au montage d'un contenu qui apparaît après le premier affichage", () => {
    test("branche de t-if", async () => {
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary>${FALLBACK}<p>ok</p><t t-if="show"><Boom/></t></ErrorBoundary></div>`;
            static components = { Boom };
            @state accessor show = false;
        }
        const { component, html } = await render(Parent);
        expect(html()).toBe("<div><p>ok</p></div>");
        component.show = true;
        await settle();
        expect(html()).toBe("<div>KO constructeur</div>");
    });

    test("nouvelle ligne de t-foreach", async () => {
        class Row extends Component {
            static template = xml`<i>{{ props.n }}</i>`;
            props = props({ n: t.number() });
            constructor() {
                super();
                if (this.props.n === 2) {
                    throw new Error("ligne 2");
                }
            }
        }
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary>${FALLBACK}<Row t-foreach="items" t-as="n" t-key="n" n="n"/></ErrorBoundary></div>`;
            static components = { Row };
            @state accessor items = [1];
        }
        const { component, html } = await render(Parent);
        expect(html()).toBe("<div><i>1</i></div>");
        component.items = [1, 2];
        await settle();
        expect(html()).toBe("<div>KO ligne 2</div>");
    });

    test("composant recréé par t-key", async () => {
        class Child extends Component {
            static template = xml`<i>{{ props.id }}</i>`;
            props = props({ id: t.number() });
            constructor() {
                super();
                if (this.props.id === 2) {
                    throw new Error("id 2");
                }
            }
        }
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary>${FALLBACK}<Child t-key="id" id="id"/></ErrorBoundary></div>`;
            static components = { Child };
            @state accessor id = 1;
        }
        const { component, html } = await render(Parent);
        component.id = 2;
        await settle();
        expect(html()).toBe("<div>KO id 2</div>");
    });
});

describe("<ErrorBoundary> imbriquées et remontée", () => {
    test("la plus proche intercepte ; l'extérieure n'est pas touchée", async () => {
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary><t t-set-slot="fallback">EXT</t><p>x</p><ErrorBoundary><t t-set-slot="fallback">INT</t><Boom/></ErrorBoundary></ErrorBoundary></div>`;
            static components = { Boom };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<div><p>x</p>INT</div>");
    });

    test("une erreur dans le fallback remonte à l'<ErrorBoundary> suivante", async () => {
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary><t t-set-slot="fallback">EXT</t><ErrorBoundary><t t-set-slot="fallback"><Boom/></t><Boom/></ErrorBoundary></ErrorBoundary></div>`;
            static components = { Boom };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<div>EXT</div>");
    });

    test("reset() reconstruit le contenu", async () => {
        let fail = true;
        class Flaky extends Component {
            static template = xml`<i>ok</i>`;
            constructor() {
                super();
                if (fail) {
                    throw new Error("instable");
                }
            }
        }
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary><t t-set-slot="fallback" t-slot-scope="e"><button t-on-click="e.reset">réessayer</button></t><Flaky/></ErrorBoundary></div>`;
            static components = { Flaky };
        }
        const { fixture, html } = await render(Parent);
        expect(html()).toBe("<div><button>réessayer</button></div>");
        fail = false;
        (fixture.querySelector("button") as HTMLButtonElement).click();
        await nextTick();
        expect(html()).toBe("<div><i>ok</i></div>");
    });
});

describe("sans <ErrorBoundary> : le premier gestionnaire", () => {
    test("pendant le montage : mount() est rejeté avec l'erreur d'origine", async () => {
        class Parent extends Component {
            static template = xml`<div><Mid/></div>`;
            static components = { Mid: mid(`<Boom/>`, { Boom }) };
        }
        await expect(mount(Parent, document.createElement("div"))).rejects.toThrow("constructeur");
    });

    test("après le montage : onError reçoit l'erreur", async () => {
        const errors: unknown[] = [];
        class Parent extends Component {
            static template = xml`<div><t t-if="show"><Boom/></t></div>`;
            static components = { Boom };
            @state accessor show = false;
        }
        const { component } = await render(Parent, { onError: (e) => errors.push(e) });
        component.show = true;
        await settle();
        expect(errors.map(String)).toEqual(["Error: constructeur"]);
    });
});

/** Composant intermédiaire au template donné. */
function mid(template: string, components: Record<string, ComponentClass>): ComponentClass {
    return class Mid extends Component {
        static template = xml`${template}`;
        static components = components;
    };
}
