import { afterEach, describe, expect, test } from "vitest";
import { Component, load, props, resource, state, t, xml } from "../src/index";
import { check, cleanup, click, deferred, find, input, render, settle, trigger, waitFor } from "../src/testing";

afterEach(cleanup);

class Counter extends Component {
    static template = xml`<div><button t-on-click="() => count++">{{ count }}</button><span class="double">{{ count * 2 }}</span></div>`;
    @state accessor count = 0;
}

describe("trame/testing", () => {
    test("render : monte dans un fixture attaché au document, html(), component", async () => {
        const { fixture, html, component } = await render(Counter);
        expect(document.body.contains(fixture)).toBe(true);
        expect(fixture.hasAttribute("data-trame-fixture")).toBe(true);
        expect(html()).toBe('<div><button>0</button><span class="double">0</span></div>');
        expect(component.count).toBe(0);
    });

    test("render : mode dev activé par défaut (validation des props)", async () => {
        class Strict extends Component {
            static template = xml`<p>{{ props.id }}</p>`;
            props = props({ id: t.number() });
        }
        await expect(render(Strict, { props: { id: "x" } })).rejects.toThrow(/Prop "id" invalide/);
        // Le fixture d'un montage échoué est retiré.
        expect(document.querySelectorAll("[data-trame-fixture]").length).toBe(0);
    });

    test("cleanup : démonte tout et retire les fixtures", async () => {
        await render(Counter);
        await render(Counter);
        expect(document.querySelectorAll("[data-trame-fixture]").length).toBe(2);
        cleanup();
        expect(document.querySelectorAll("[data-trame-fixture]").length).toBe(0);
    });

    test("destroy : démonte un seul composant", async () => {
        const a = await render(Counter);
        await render(Counter);
        a.destroy();
        expect(document.body.contains(a.fixture)).toBe(false);
        expect(document.querySelectorAll("[data-trame-fixture]").length).toBe(1);
    });

    test("click : met à jour le DOM", async () => {
        const { fixture } = await render(Counter);
        await click("button", fixture);
        await click(find("button", fixture));
        expect(find(".double", fixture).textContent).toBe("4");
    });

    test("input, check, trigger", async () => {
        class Form extends Component {
            static template = xml`
                <div>
                    <input class="name" t-att-value="name" t-on-input="(ev) => name = ev.target.value"/>
                    <input class="ok" type="checkbox" t-on-change="(ev) => ok = ev.target.checked"/>
                    <div class="zone" t-on-custom="() => hits++"/>
                    <p>{{ name }}|{{ ok }}|{{ hits }}</p>
                </div>`;
            @state accessor name = "";
            @state accessor ok = false;
            @state accessor hits = 0;
        }
        const { fixture } = await render(Form);
        await input(".name", "Alice", {}, fixture);
        await check(".ok", true, fixture);
        await trigger(".zone", "custom", {}, fixture);
        expect(find("p", fixture).textContent).toBe("Alice|true|1");
    });

    test("find : erreur explicite si l'élément n'existe pas", async () => {
        const { fixture } = await render(Counter);
        expect(() => find(".absent", fixture)).toThrow(/Aucun élément ne correspond à "\.absent"/);
    });

    test("deferred + settle : contrôle d'une réponse serveur", async () => {
        const d = deferred<string>();
        class Async extends Component {
            static template = xml`<div><p t-if="show">{{ data }}</p></div>`;
            @state accessor show = false;
            @resource accessor data = load(() => d.promise);
        }
        const { component, html } = await render(Async);
        component.show = true;
        await settle();
        expect(html()).toBe("<div></div>");
        d.resolve("chargé");
        await settle();
        expect(html()).toBe("<div><p>chargé</p></div>");
    });

    test("deferred : rejet", async () => {
        const d = deferred<number>();
        d.reject(new Error("KO"));
        await expect(d.promise).rejects.toThrow("KO");
    });

    test("waitFor : réessaie jusqu'au succès, renvoie le résultat", async () => {
        let n = 0;
        setTimeout(() => (n = 3), 30);
        const value = await waitFor(() => {
            expect(n).toBe(3);
            return n * 2;
        });
        expect(value).toBe(6);
    });

    test("waitFor : relance la dernière erreur après le délai", async () => {
        await expect(
            waitFor(
                () => {
                    throw new Error("jamais");
                },
                { timeout: 50 },
            ),
        ).rejects.toThrow("jamais");
    });
});
