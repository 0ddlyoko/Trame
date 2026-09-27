import { afterEach, describe, expect, test, vi } from "vitest";
import { Component, effect, load, nextTick, props, resource, state, t, xml } from "../../src/index";
import { cleanup, click, deferred, render, settle } from "../../src/testing";

afterEach(cleanup);

describe("t-key hors d'une boucle", () => {
    test("composant : recréé quand la clé change (état local remis à zéro)", async () => {
        const created = vi.fn();
        class OrderForm extends Component {
            static template = xml`<div><span class="id">{{ props.orderId }}</span><span class="tab">{{ tab }}</span><button t-on-click="() => tab = 'history'">h</button></div>`;
            props = props({ orderId: t.number() });
            @state accessor tab = "lines";
            constructor() {
                super();
                created();
            }
        }
        class Host extends Component {
            static template = xml`<OrderForm t-key="orderId" orderId="orderId"/>`;
            static components = { OrderForm };
            @state accessor orderId = 1;
            @state accessor other = 0;
        }
        const { fixture, component } = await render(Host);
        await click("button", fixture);
        expect(fixture.querySelector(".tab")!.textContent).toBe("history");
        // Un changement sans rapport avec la clé ne recrée rien.
        component.other = 5;
        await nextTick();
        expect(created).toHaveBeenCalledTimes(1);
        // Changement de clé : nouvelle instance, état local remis à zéro.
        component.orderId = 2;
        await nextTick();
        expect(created).toHaveBeenCalledTimes(2);
        expect(fixture.querySelector(".id")!.textContent).toBe("2");
        expect(fixture.querySelector(".tab")!.textContent).toBe("lines");
    });

    test("sans t-key : même instance, l'état local est conservé (comportement par défaut)", async () => {
        class Child extends Component {
            static template = xml`<span>{{ props.id }}/{{ local }}</span>`;
            props = props({ id: t.number() });
            @state accessor local = "a";
        }
        class Host extends Component {
            static template = xml`<Child id="id"/>`;
            static components = { Child };
            @state accessor id = 1;
        }
        const { fixture, component } = await render(Host);
        const child = fixture.querySelector("span")!;
        component.id = 2;
        await nextTick();
        expect(fixture.querySelector("span")).toBe(child);
        expect(child.textContent).toBe("2/a");
    });

    test("les effets de l'ancienne instance sont nettoyés, ceux de la nouvelle démarrent", async () => {
        const log: string[] = [];
        class Child extends Component {
            static template = xml`<i/>`;
            props = props({ id: t.number() });
            @effect track() {
                const id = this.props.id;
                log.push(`start ${id}`);
                return () => log.push(`stop ${id}`);
            }
        }
        class Host extends Component {
            static template = xml`<div><Child t-key="id" id="id"/></div>`;
            static components = { Child };
            @state accessor id = 1;
        }
        const { component } = await render(Host);
        component.id = 2;
        await nextTick();
        expect(log).toEqual(["start 1", "stop 1", "start 2"]);
    });

    test("élément HTML : recréé quand la clé change", async () => {
        class Host extends Component {
            static template = xml`<div><input t-key="version"/></div>`;
            @state accessor version = 1;
        }
        const { fixture, component } = await render(Host);
        const first = fixture.querySelector("input")!;
        component.version = 2;
        await nextTick();
        expect(fixture.querySelector("input")).not.toBe(first);
        expect(fixture.querySelectorAll("input").length).toBe(1);
    });

    test("combiné avec t-if", async () => {
        class Host extends Component {
            static template = xml`<div><p t-if="show" t-key="k">{{ k }}</p></div>`;
            @state accessor show = true;
            @state accessor k = 1;
        }
        const { fixture, component } = await render(Host);
        const p = fixture.querySelector("p")!;
        component.k = 2;
        await nextTick();
        expect(fixture.querySelector("p")).not.toBe(p);
        expect(fixture.innerHTML).toBe("<div><p>2</p></div>");
        component.show = false;
        await nextTick();
        expect(fixture.innerHTML).toBe("<div></div>");
    });

    test("la nouvelle instance est préparée hors du DOM : l'ancienne reste affichée pendant son chargement", async () => {
        const loads = new Map<number, ReturnType<typeof deferred<string>>>();
        class OrderView extends Component {
            static template = xml`<h1>{{ order }}</h1>`;
            props = props({ id: t.number() });
            @resource accessor order = load(() => {
                const d = deferred<string>();
                loads.set(this.props.id, d);
                return d.promise;
            });
        }
        class Host extends Component {
            static template = xml`<div><OrderView t-key="id" id="id"/></div>`;
            static components = { OrderView };
            @state accessor id = 1;
        }
        const fixture = document.createElement("div");
        document.body.appendChild(fixture);
        const { mount } = await import("../../src/index");
        const promise = mount(Host, fixture);
        loads.get(1)!.resolve("SO001");
        const root = await promise;
        root.component.id = 2;
        await settle();
        expect(fixture.innerHTML).toBe("<div><h1>SO001</h1></div>");
        loads.get(2)!.resolve("SO002");
        await settle();
        expect(fixture.innerHTML).toBe("<div><h1>SO002</h1></div>");
        root.destroy();
        fixture.remove();
    });
});
