// Données d'une commande : classes réactives, indépendantes de l'affichage.
// Plusieurs vues peuvent afficher la même instance : une modification se voit partout.

import { computed, state } from "trame";

let nextLineId = 1;

/** Champs modifiables d'une ligne. */
export type OrderLineValues = Pick<OrderLine, "product" | "price" | "quantity" | "discount">;

/** Une ligne de commande. */
export class OrderLine {
    readonly id = nextLineId++;

    @state accessor product: string;
    @state accessor price: number;
    @state accessor quantity: number;
    /** Remise en pourcentage (0 - 100). */
    @state accessor discount: number;

    constructor(product = "", price = 0, quantity = 1, discount = 0) {
        this.product = product;
        this.price = price;
        this.quantity = quantity;
        this.discount = discount;
    }

    // Recalculé uniquement quand on le lit après un changement de price, quantity ou discount.
    @computed get total(): number {
        return this.price * this.quantity * (1 - this.discount / 100);
    }

    update(changes: Partial<OrderLineValues>): void {
        Object.assign(this, changes);
    }
}

export class Order {
    @state accessor name: string;
    // Un tableau dans un @state est réactif en profondeur : push, splice... sont suivis.
    @state accessor lines: OrderLine[];

    constructor(name = "", lines: OrderLine[] = []) {
        this.name = name;
        this.lines = lines;
    }

    // Dépend de la liste et du total de chaque ligne (dépendances dynamiques).
    @computed get total(): number {
        return this.lines.reduce((sum, line) => sum + line.total, 0);
    }

    addLine(line = new OrderLine()): OrderLine {
        this.lines.push(line);
        return line;
    }

    removeLine(line: OrderLine): void {
        const index = this.lines.indexOf(line);
        if (index !== -1) {
            this.lines.splice(index, 1);
        }
    }
}
