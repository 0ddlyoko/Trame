// Non-régression : points soulevés par la revue de code (un bloc describe par point).
import { describe, expect, test } from "vitest";
import { Component, state, xml } from "../src/index";
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
