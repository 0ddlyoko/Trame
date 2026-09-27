// Test de bout en bout de l'exemple examples/order (faux backend avec délai réseau).
import { describe, expect, test, vi } from "vitest";
import { Component, mount, nextTick, state, xml } from "../src/index";
import { OrderForm } from "../examples/order/order_form";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function input(el: HTMLInputElement, value: string) {
    el.value = value;
    el.dispatchEvent(new Event("input"));
}

describe("exemple : formulaire de commande", () => {
    test("chargement, édition, ajout/suppression de lignes, rechargement, enregistrement", async () => {
        const saved = vi.fn();
        class Host extends Component {
            static components = { OrderForm };
            static template = xml`<OrderForm orderId="orderId" readonly="readonly" onSaved="onSaved"/>`;
            @state accessor orderId = 1;
            @state accessor readonly = false;
            onSaved = saved;
        }
        const fixture = document.createElement("div");
        document.body.appendChild(fixture);
        const start = Date.now();
        const root = await mount(Host, fixture, { dev: true });
        expect(Date.now() - start).toBeGreaterThanOrEqual(350);

        const total = () => fixture.querySelector("footer strong")!.textContent;
        const rows = () => fixture.querySelectorAll("tbody tr");
        // SO001 : 2 × 250 + 4 × 80 × 0,9 = 788
        expect((fixture.querySelector("h1 input") as HTMLInputElement).value).toBe("SO001");
        expect(rows().length).toBe(2);
        expect(total()).toBe("Total : 788.00 €");

        // Édition de la quantité : seuls le total de la ligne et le total général changent.
        const firstRow = rows()[0];
        const qty = firstRow.querySelectorAll("input")[2] as HTMLInputElement;
        input(qty, "3");
        await nextTick();
        expect(firstRow.querySelector(".amount")!.textContent).toBe("750.00");
        expect(total()).toBe("Total : 1038.00 €");
        expect(rows()[0]).toBe(firstRow);

        // Ajout puis suppression d'une ligne
        const buttons = () => Array.from(fixture.querySelectorAll("footer button")) as HTMLButtonElement[];
        buttons()[0].click();
        expect(rows().length).toBe(3);
        (rows()[2].querySelector("button") as HTMLButtonElement).click();
        expect(rows().length).toBe(2);
        expect(rows()[0]).toBe(firstRow);

        // Lecture seule : les boutons disparaissent
        root.component.readonly = true;
        await nextTick();
        expect(buttons().length).toBe(0);
        expect(firstRow.querySelector("input")!.hasAttribute("readonly")).toBe(true);
        root.component.readonly = false;
        await nextTick();

        // Enregistrement
        buttons()[1].click();
        await nextTick();
        expect(buttons()[1].textContent).toBe("Enregistrement…");
        await wait(400);
        expect(saved).toHaveBeenCalledTimes(1);
        expect(buttons()[1].textContent).toBe("Enregistrer");

        // Changement de commande : l'ancienne reste affichée pendant le rechargement
        root.component.orderId = 2;
        await nextTick();
        expect(fixture.querySelector("h1 small")!.textContent).toBe("rechargement…");
        expect((fixture.querySelector("h1 input") as HTMLInputElement).value).toBe("SO001");
        await wait(500);
        expect((fixture.querySelector("h1 input") as HTMLInputElement).value).toBe("SO002");
        expect(fixture.querySelector("h1 small")).toBeNull();
        expect(total()).toBe("Total : 912.00 €");

        // Retour à la commande 1 : la modification enregistrée a été conservée par le faux backend
        root.component.orderId = 1;
        await wait(500);
        expect(total()).toBe("Total : 1038.00 €");
        root.destroy();
    });
});
