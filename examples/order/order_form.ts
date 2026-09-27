// Formulaire de commande.

import { Component, load, props, resource, state, t, xml } from "trame";
import { fetchOrder, saveOrder } from "./api";
import type { Order } from "./order";
import { OrderLineRow } from "./order_line_row";

export class OrderForm extends Component {
    static components = { OrderLineRow };

    static template = xml`
        <div class="o-order">
            <!-- Lire "order" suffit : le formulaire n'est affiché qu'une fois la commande chargée. -->
            <h1>
                <input t-att-value="order.name" t-att-readonly="props.readonly"
                       t-on-input="(ev) => order.name = ev.target.value"/>
                <!-- Rechargement (props.orderId a changé) : l'ancienne commande reste affichée. -->
                <small t-if="loading(order)">rechargement…</small>
            </h1>

            <table>
                <thead>
                    <tr><th>Produit</th><th>Prix</th><th>Qté</th><th>Remise</th><th>Total</th><th/></tr>
                </thead>
                <tbody>
                    <OrderLineRow t-foreach="order.lines" t-as="line" t-key="line.id"
                                  line="line"
                                  readonly="props.readonly"
                                  onUpdate="(changes) => line.update(changes)"
                                  onRemove="() => order.removeLine(line)"/>
                </tbody>
            </table>

            <p t-if="!order.lines.length" class="empty">Aucune ligne.</p>

            <footer>
                <t t-if="!props.readonly">
                    <button t-on-click="() => order.addLine()">Ajouter une ligne</button>
                    <button t-on-click="save" t-att-disabled="saving">{{ saving ? 'Enregistrement…' : 'Enregistrer' }}</button>
                </t>
                <strong>Total : {{ order.total.toFixed(2) }} €</strong>
            </footer>
        </div>
    `;

    // Entrées du composant : types TS inférés, validation en mode dev, valeurs par défaut.
    props = props({
        orderId: t.number(),
        readonly: t.boolean().default(false),
        onSaved: t.func<(order: Order) => void>().optional(),
    });

    @state accessor saving = false;

    // Chargée à la première lecture ; l'affichage attend qu'elle soit prête.
    // Relancée automatiquement si props.orderId change (la requête en cours est annulée).
    @resource accessor order = load(({ signal }) => fetchOrder(this.props.orderId, signal));

    async save() {
        this.saving = true;
        try {
            await saveOrder(this.props.orderId, this.order);
            this.props.onSaved?.(this.order);
        } finally {
            this.saving = false;
        }
    }
}
