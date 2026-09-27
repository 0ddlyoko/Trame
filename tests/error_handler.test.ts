// Erreurs d'actions (gestionnaires d'événements) : <ErrorHandler>, onError, console.
// Les erreurs de rendu (liaisons, effets, construction, chargement) restent l'affaire de <ErrorBoundary>.
import { afterEach, describe, expect, test, vi } from "vitest";
import { Component, mount, nextTick, props, state, t, xml } from "../src/index";
import { render, settle } from "./helpers";

afterEach(() => {
    vi.restoreAllMocks();
});

/** Formulaire dont l'enregistrement échoue (synchrone ou asynchrone). */
class Form extends Component {
    static template = xml`<form><input class="name" t-att-value="name"/><button class="sync" t-on-click="failNow">a</button><button class="async" t-on-click="failLater">b</button></form>`;
    @state accessor name = "saisie en cours";
    failNow() {
        throw new Error("erreur synchrone");
    }
    async failLater() {
        await Promise.resolve();
        throw new Error("erreur du serveur");
    }
}

function click(fixture: HTMLElement, selector: string) {
    (fixture.querySelector(selector) as HTMLElement).click();
}

describe("<ErrorHandler> : erreurs des gestionnaires d'événements", () => {
    test("reçoit les erreurs synchrones et asynchrones ; le contenu reste en place", async () => {
        const received: string[] = [];
        class App extends Component {
            static template = xml`<div><ErrorHandler onError="(e) => report(e)"><Form/></ErrorHandler></div>`;
            static components = { Form };
            report(error: Error) {
                received.push(error.message);
            }
        }
        const { fixture, html } = await render(App);
        const before = html();
        click(fixture, ".sync");
        click(fixture, ".async");
        await settle();
        expect(received).toEqual(["erreur synchrone", "erreur du serveur"]);
        expect(html()).toBe(before);
    });

    test("une <ErrorBoundary> ne remplace pas son contenu pour une erreur d'action", async () => {
        const received: string[] = [];
        class App extends Component {
            static template = xml`<div><ErrorHandler onError="(e) => report(e)"><ErrorBoundary><t t-set-slot="fallback">KO</t><Form/></ErrorBoundary></ErrorHandler></div>`;
            static components = { Form };
            report(error: Error) {
                received.push(error.message);
            }
        }
        const { fixture, html } = await render(App);
        click(fixture, ".async");
        await settle();
        expect(received).toEqual(["erreur du serveur"]);
        expect(html()).not.toContain("KO");
        expect(fixture.querySelector("form")).not.toBeNull();
    });

    test("le plus proche l'emporte ; s'il lève à son tour, l'erreur remonte au suivant", async () => {
        const log: string[] = [];
        class App extends Component {
            static template = xml`
                <div>
                    <ErrorHandler onError="(e) => log('externe : ' + e.message)">
                        <ErrorHandler onError="(e) => log('interne : ' + e.message)"><Form/></ErrorHandler>
                        <ErrorHandler onError="(e) => rethrow(e)"><p><button class="b" t-on-click="() => fail()">x</button></p></ErrorHandler>
                    </ErrorHandler>
                </div>`;
            static components = { Form };
            log(line: string) {
                log.push(line);
            }
            rethrow(error: Error) {
                throw new Error(`relancée (${error.message})`);
            }
            fail() {
                throw new Error("bouton");
            }
        }
        const { fixture } = await render(App);
        click(fixture, ".sync");
        click(fixture, ".b");
        await settle();
        expect(log).toEqual(["interne : erreur synchrone", "externe : relancée (bouton)"]);
    });

    test("n'intercepte pas les erreurs de rendu : elles vont à l'<ErrorBoundary>", async () => {
        const received: unknown[] = [];
        class Broken extends Component {
            static template = xml`<i>{{ missing.x }}</i>`;
            missing: { x: number } | null = null;
        }
        class App extends Component {
            static template = xml`<div><ErrorBoundary><t t-set-slot="fallback">KO</t><ErrorHandler onError="(e) => received.push(e)"><Broken/></ErrorHandler></ErrorBoundary></div>`;
            static components = { Broken };
            received = received;
        }
        const { html } = await render(App);
        expect(html()).toBe("<div>KO</div>");
        expect(received).toEqual([]);
    });

    test("onError est une prop obligatoire (mode dev)", async () => {
        class App extends Component {
            static template = xml`<div><ErrorHandler><p/></ErrorHandler></div>`;
        }
        await expect(render(App)).rejects.toThrow(/onError/);
    });
});

describe("sans <ErrorHandler> : erreurs d'actions", () => {
    test("mount({ onError }) les reçoit ; l'application reste montée", async () => {
        const errors: string[] = [];
        const { fixture, html } = await render(Form, { onError: (e) => errors.push((e as Error).message) });
        click(fixture, ".sync");
        click(fixture, ".async");
        await settle();
        expect(errors).toEqual(["erreur synchrone", "erreur du serveur"]);
        expect(html()).toContain("<form>");
    });

    test("sans aucun gestionnaire : affichées dans la console, l'application continue", async () => {
        const logged: unknown[] = [];
        vi.spyOn(console, "error").mockImplementation((e) => void logged.push(e));
        class Counter extends Component {
            static template = xml`<div><button class="fail" t-on-click="fail">x</button><button class="inc" t-on-click="() => n++">+</button><span>{{ n }}</span></div>`;
            @state accessor n = 0;
            fail() {
                throw new Error("action ratée");
            }
        }
        const fixture = document.createElement("div");
        document.body.appendChild(fixture);
        const root = await mount(Counter, fixture);
        click(fixture, ".fail");
        await settle();
        expect(String(logged[0])).toMatch(/action ratée/);
        click(fixture, ".inc");
        await nextTick();
        expect(fixture.querySelector("span")!.textContent).toBe("1");
        root.destroy();
        fixture.remove();
    });

    test("en mode dev, l'erreur indique toujours le gestionnaire fautif dans le template", async () => {
        const errors: unknown[] = [];
        class C extends Component {
            static template = xml`<div>
                <button t-on-click="fail">x</button>
            </div>`;
            fail() {
                throw new Error("boum");
            }
        }
        const { fixture } = await render(C, { onError: (e) => errors.push(e) });
        click(fixture, "button");
        expect((errors[0] as { trameLocation?: string }).trameLocation).toMatch(/template "C", ligne 2 : t-on-click="fail"/);
    });

    test("une erreur de rendu non interceptée démonte toujours l'application", async () => {
        const logged: unknown[] = [];
        vi.spyOn(console, "error").mockImplementation((e) => void logged.push(e));
        class Child extends Component {
            static template = xml`<i>{{ props.v.x }}</i>`;
            props = props({ v: t.any<{ x: number } | null>() });
        }
        class App extends Component {
            static template = xml`<div><Child v="v"/></div>`;
            static components = { Child };
            @state accessor v: { x: number } | null = { x: 1 };
        }
        const fixture = document.createElement("div");
        document.body.appendChild(fixture);
        const root = await mount(App, fixture);
        root.component.v = null;
        await nextTick();
        expect(logged.length).toBe(1);
        expect(fixture.innerHTML).toBe("");
        fixture.remove();
    });
});
