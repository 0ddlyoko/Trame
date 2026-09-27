// Une ligne du tableau de commande.
// Les props sont en lecture seule (en profondeur) : le composant ne modifie jamais la ligne,
// il prévient le parent via onUpdate / onRemove, et le parent agit en conséquence.

import { Component, props, t, xml } from "trame";
import { OrderLine, type OrderLineValues } from "./order";

export class OrderLineRow extends Component {
    static template = xml`
        <tr>
            <td>
                <input t-att-value="props.line.product" t-att-readonly="props.readonly"
                       t-on-input="(ev) => props.onUpdate({ product: ev.target.value })"/>
            </td>
            <td>
                <input type="number" t-att-value="props.line.price" t-att-readonly="props.readonly"
                       t-on-input="(ev) => props.onUpdate({ price: ev.target.valueAsNumber || 0 })"/>
            </td>
            <td>
                <input type="number" t-att-value="props.line.quantity" t-att-readonly="props.readonly"
                       t-on-input="(ev) => props.onUpdate({ quantity: ev.target.valueAsNumber || 0 })"/>
            </td>
            <td>
                <input type="number" t-att-value="props.line.discount" t-att-readonly="props.readonly"
                       t-on-input="(ev) => props.onUpdate({ discount: ev.target.valueAsNumber || 0 })"/> %
            </td>
            <td class="amount">{{ props.line.total.toFixed(2) }}</td>
            <td><button t-if="!props.readonly" t-on-click="props.onRemove">✕</button></td>
        </tr>
    `;

    props = props({
        line: t.instanceOf(OrderLine),
        readonly: t.boolean().default(false),
        onUpdate: t.func<(changes: Partial<OrderLineValues>) => void>(),
        onRemove: t.func<() => void>(),
    });
}
