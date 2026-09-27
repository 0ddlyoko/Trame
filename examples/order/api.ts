// Faux backend en mémoire, avec un délai réseau simulé et la prise en charge de l'annulation.

import { Order, OrderLine } from "./order";

interface OrderData {
    name: string;
    lines: { product: string; price: number; quantity: number; discount: number }[];
}

const database = new Map<number, OrderData>([
    [1, { name: "SO001", lines: [{ product: "Bureau", price: 250, quantity: 2, discount: 0 }, { product: "Chaise", price: 80, quantity: 4, discount: 10 }] }],
    [2, { name: "SO002", lines: [{ product: "Écran 27\"", price: 320, quantity: 3, discount: 5 }] }],
    [3, { name: "SO003", lines: [] }],
]);

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Requête annulée", "AbortError"));
        });
    });
}

export async function fetchOrder(id: number, signal: AbortSignal): Promise<Order> {
    await delay(400, signal);
    const data = database.get(id);
    if (data === undefined) {
        throw new Error(`Commande ${id} introuvable`);
    }
    return new Order(
        data.name,
        data.lines.map((l) => new OrderLine(l.product, l.price, l.quantity, l.discount)),
    );
}

export async function saveOrder(id: number, order: Order): Promise<void> {
    // Les champs @state sont des accessors : @state fournit un toJSON() pour que la sérialisation fonctionne.
    const data = JSON.parse(JSON.stringify(order)) as OrderData;
    await delay(300);
    database.set(id, data);
}
