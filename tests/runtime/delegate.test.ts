import { afterEach, describe, expect, test } from "vitest";
import { Component, state, xml } from "../../src/index";
import { cleanup, click, find, render, trigger } from "../../src/testing";

afterEach(cleanup);

/** Compte les appels à addEventListener faits sur des éléments et sur le document pendant `fn`. */
async function countListeners<T>(fn: () => Promise<T>): Promise<{ result: T; onElements: number; onDocument: number }> {
    let onElements = 0;
    let onDocument = 0;
    const elementAdd = Element.prototype.addEventListener;
    const documentAdd = Document.prototype.addEventListener;
    Element.prototype.addEventListener = function (this: Element, ...args: Parameters<typeof elementAdd>) {
        onElements++;
        return elementAdd.apply(this, args);
    } as typeof elementAdd;
    Document.prototype.addEventListener = function (this: Document, ...args: Parameters<typeof documentAdd>) {
        onDocument++;
        return documentAdd.apply(this, args);
    } as typeof documentAdd;
    try {
        const result = await fn();
        return { result, onElements, onDocument };
    } finally {
        Element.prototype.addEventListener = elementAdd;
        Document.prototype.addEventListener = documentAdd;
    }
}

describe("t-on-*.delegate", () => {
    test("aucun écouteur sur les éléments de la liste, les clics fonctionnent", async () => {
        class List extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="i" t-key="i"><button t-on-click.delegate="() => pick(i)">{{ i }}</button></li></ul><p>{{ picked }}</p>`;
            @state accessor items = Array.from({ length: 50 }, (_, i) => i);
            @state accessor picked = -1;
            pick(i: number) {
                this.picked = i;
            }
        }
        const { result, onElements, onDocument } = await countListeners(() => render(List));
        expect(onElements).toBe(0);
        expect(onDocument).toBeLessThanOrEqual(1);
        const { fixture } = result;
        await click(fixture.querySelectorAll("button")[42]);
        expect(find("p", fixture).textContent).toBe("42");
    });

    test("un clic sur un enfant de l'élément déclenche son gestionnaire", async () => {
        class Card extends Component {
            static template = xml`<div class="card" t-on-click.delegate="() => count++"><span class="inner">x</span></div><p>{{ count }}</p>`;
            @state accessor count = 0;
        }
        const { fixture } = await render(Card);
        await click(".inner", fixture);
        expect(find("p", fixture).textContent).toBe("1");
    });

    test(".stop arrête la remontée vers les gestionnaires délégués des ancêtres", async () => {
        class Nested extends Component {
            static template = xml`
                <div t-on-click.delegate="() => outer++">
                    <button class="stop" t-on-click.delegate.stop="() => inner++">a</button>
                    <button class="go" t-on-click.delegate="() => inner++">b</button>
                </div>
                <p>{{ inner }}/{{ outer }}</p>`;
            @state accessor inner = 0;
            @state accessor outer = 0;
        }
        const { fixture } = await render(Nested);
        await click(".stop", fixture);
        expect(find("p", fixture).textContent).toBe("1/0");
        await click(".go", fixture);
        expect(find("p", fixture).textContent).toBe("2/1");
    });

    test(".self et .prevent", async () => {
        class Links extends Component {
            static template = xml`<a href="#" t-on-click.delegate.prevent.self="() => hits++"><b>x</b></a><p>{{ hits }}</p>`;
            @state accessor hits = 0;
        }
        const { fixture } = await render(Links);
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
        find("b", fixture).dispatchEvent(ev);
        expect(find("p", fixture).textContent).toBe("0");
        find("a", fixture).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(find("p", fixture).textContent).toBe("1");
    });

    test("un élément supprimé ne reçoit plus rien", async () => {
        class Toggle extends Component {
            static template = xml`<div><button t-if="show" t-on-click.delegate="() => hits++">x</button></div><p>{{ hits }}</p>`;
            @state accessor show = true;
            @state accessor hits = 0;
        }
        const { fixture, component } = await render(Toggle);
        const button = find("button", fixture);
        component.show = false;
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        button.click();
        expect(find("p", fixture).textContent).toBe("0");
    });

    test("événement qui ne remonte pas (focus) : écouteur posé sur l'élément", async () => {
        class Field extends Component {
            static template = xml`<input t-on-focus.delegate="() => focused++"/><p>{{ focused }}</p>`;
            @state accessor focused = 0;
        }
        const { result, onElements } = await countListeners(() => render(Field));
        expect(onElements).toBe(1);
        await trigger("input", "focus", { bubbles: false }, result.fixture);
        expect(find("p", result.fixture).textContent).toBe("1");
    });
});
