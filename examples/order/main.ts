// Point d'entrée de la démo : `npm run example`, puis ouvrir l'URL affichée.

import { Component, mount, state, xml } from "trame";
import { OrderForm } from "./order_form";

class App extends Component {
    static components = { OrderForm };

    static template = xml`
        <div class="app">
            <nav>
                <button t-foreach="[1, 2, 3]" t-as="id" t-key="id"
                        t-att-class="{ active: id === orderId }"
                        t-on-click="() => orderId = id">Commande {{ id }}</button>
                <label>
                    <input type="checkbox" t-att-checked="readonly" t-on-change="(ev) => readonly = ev.target.checked"/>
                    Lecture seule
                </label>
            </nav>
            <OrderForm orderId="orderId" readonly="readonly" onSaved="(order) => lastSaved = order.name"/>
            <p t-if="lastSaved" class="saved">Dernier enregistrement : {{ lastSaved }}</p>
        </div>
    `;

    @state accessor orderId = 1;
    @state accessor readonly = false;
    @state accessor lastSaved = "";
}

const target = document.getElementById("app")!;
const waiting = document.createElement("p");
waiting.textContent = "Chargement de la commande…";
target.appendChild(waiting);

// mount() est résolu une fois l'application insérée, c'est-à-dire quand la commande est chargée.
mount(App, target, { dev: true }).then(() => waiting.remove());
