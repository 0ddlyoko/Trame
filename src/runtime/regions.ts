/**
 * Régions dynamiques du DOM.
 *
 * Une région est un emplacement repéré par un nœud d'ancrage (texte vide) : son contenu est inséré
 * juste avant. Elle gère un ou plusieurs « items » (blocs construits sous leur propre scope).
 *
 * Quand une région est déjà affichée (scope vivant) et qu'un nouveau contenu doit apparaître,
 * celui-ci est préparé hors du DOM sous une frontière d'attente locale : il n'est inséré qu'une
 * fois toutes ses données chargées. Pour un t-if, l'ancien contenu reste affiché en attendant.
 */

import { annotateError, Effect, PRIORITY_RENDER, untrack } from "../reactivity/core";
import { Boundary, getOwner, Owner, runWithOwner } from "../reactivity/owner";
import { Signal } from "../reactivity/core";

export abstract class Region {
    constructor(readonly anchor: Node) {}

    /** Premier nœud DOM actuellement occupé par la région (l'ancre si elle est vide). */
    abstract firstNode(): Node;
}

export type Root = Node | Region;
export type BlockBuilder = () => Root[];

export interface Item {
    roots: Root[];
    owner: Owner;
    /** Nœud temporaire occupant la place de l'item tant qu'il n'est pas prêt. */
    placeholder: Node | null;
}

export function firstOf(root: Root): Node {
    return root instanceof Region ? root.firstNode() : root;
}

function lastOf(root: Root): Node {
    return root instanceof Region ? root.anchor : root;
}

export function itemFirst(item: Item): Node {
    return item.placeholder ?? firstOf(item.roots[0]);
}

export function itemLast(item: Item): Node {
    return item.placeholder ?? lastOf(item.roots[item.roots.length - 1]);
}

/** Déplace (ou insère) les nœuds de `first` à `last` avant `before`. */
export function moveRange(first: Node, last: Node, parent: Node, before: Node | null): void {
    let node: Node | null = first;
    while (node !== null) {
        const next: Node | null = node.nextSibling;
        parent.insertBefore(node, before);
        if (node === last) {
            break;
        }
        node = next;
    }
}

export function removeRange(first: Node, last: Node): void {
    let node: Node | null = first;
    while (node !== null) {
        const next: Node | null = node.nextSibling;
        node.parentNode?.removeChild(node);
        if (node === last) {
            break;
        }
        node = next;
    }
}

export function insertItem(item: Item, parent: Node, before: Node | null): void {
    moveRange(itemFirst(item), itemLast(item), parent, before);
}

export function removeItem(item: Item): void {
    item.owner.dispose();
    removeRange(itemFirst(item), itemLast(item));
}

/** Construit un bloc sous un nouveau scope enfant de `parent`. */
export function buildItem(parent: Owner, build: BlockBuilder, boundary?: Boundary): Item {
    const owner = new Owner(parent);
    if (boundary !== undefined) {
        owner.boundary = boundary;
        owner.detached = true;
    }
    try {
        const roots = runWithOwner(owner, () => untrack(build));
        return { roots, owner, placeholder: null };
    } catch (e) {
        owner.dispose();
        throw e;
    }
}

/** Effet de rendu (exécuté immédiatement). `loc` : localisation dans le template (erreurs). */
export function renderEffect(fn: () => void, loc?: string): Effect {
    const effect = new Effect(fn, getOwner(), PRIORITY_RENDER);
    effect.loc = loc;
    effect.run();
    return effect;
}

function requireOwner(): Owner {
    const owner = getOwner();
    if (owner === null) {
        throw new Error("[trame] Rendu hors d'un scope");
    }
    return owner;
}

// --- Région statique (composant, slot, t-call) ---------------------------------------------------

export class StaticRegion extends Region {
    private item: Item | null = null;

    /**
     * @param shareOwner  le contenu est seul dans un bloc qui a déjà son propre scope (ligne, branche,
     *                    slot) : il l'utilise directement au lieu d'en créer un de plus.
     */
    constructor(anchor: Node, build: BlockBuilder, loc?: string, shareOwner = false) {
        super(anchor);
        const owner = requireOwner();
        try {
            this.item = shareOwner ? { roots: runWithOwner(owner, () => untrack(build)), owner, placeholder: null } : buildItem(owner, build);
            // Détruit pendant la construction (une <ErrorBoundary> a affiché son fallback) : on s'arrête.
            if (!owner.disposed) {
                insertItem(this.item, anchor.parentNode!, anchor);
            }
        } catch (e) {
            owner.handleError(annotateError(e, loc, owner));
        }
    }

    firstNode(): Node {
        return this.item ? itemFirst(this.item) : this.anchor;
    }
}

// --- Région à contenu interchangeable (t-if, composant dynamique) --------------------------------

const NONE = Symbol("none");

interface PendingSwitch {
    key: unknown;
    item: Item;
    boundary: Boundary;
}

export class SwitchRegion extends Region {
    private current: Item | null = null;
    private currentKey: unknown = NONE;
    private pending: PendingSwitch | null = null;
    private readonly owner: Owner;

    constructor(
        anchor: Node,
        keyFn: () => unknown,
        private readonly builderFor: (key: unknown) => BlockBuilder | null,
        private readonly loc?: string,
    ) {
        super(anchor);
        this.owner = requireOwner();
        this.owner.onCleanup(() => this.cancelPending());
        renderEffect(() => {
            const key = keyFn();
            untrack(() => this.update(key));
        }, loc);
    }

    firstNode(): Node {
        return this.current ? itemFirst(this.current) : this.anchor;
    }

    private update(key: unknown): void {
        if (this.pending !== null) {
            if (this.pending.key === key) {
                return;
            }
            this.cancelPending();
        }
        if (key === this.currentKey) {
            return;
        }
        const builder = this.builderFor(key);
        const owner = this.owner;
        if (!owner.live || builder === null) {
            // Construction initiale (ou contenu non affiché) : on remplace directement.
            this.removeCurrent();
            this.currentKey = key;
            if (builder !== null) {
                try {
                    this.current = buildItem(owner, builder);
                    if (!owner.disposed) {
                        insertItem(this.current, this.anchor.parentNode!, this.anchor);
                    }
                } catch (e) {
                    owner.handleError(annotateError(e, this.loc, owner));
                }
            }
            return;
        }
        // Déjà affiché : on prépare le nouveau contenu hors du DOM, l'ancien reste visible.
        let item: Item;
        const boundary = new Boundary(
            () => this.commitPending(),
            (error) => {
                this.cancelPending();
                owner.handleError(error);
            },
        );
        try {
            item = buildItem(owner, builder, boundary);
        } catch (e) {
            owner.handleError(annotateError(e, this.loc, owner));
            return;
        }
        if (owner.disposed) {
            // Une erreur de construction a fait détruire la région (fallback d'une <ErrorBoundary>).
            boundary.cancel();
            item.owner.dispose();
            return;
        }
        this.pending = { key, item, boundary };
        boundary.done();
    }

    private commitPending(): void {
        const pending = this.pending;
        if (pending === null) {
            return;
        }
        this.pending = null;
        this.removeCurrent();
        this.current = pending.item;
        this.currentKey = pending.key;
        insertItem(pending.item, this.anchor.parentNode!, this.anchor);
        pending.item.owner.detached = false;
        if (this.owner.live) {
            pending.item.owner.activate();
        }
    }

    private cancelPending(): void {
        const pending = this.pending;
        if (pending !== null) {
            this.pending = null;
            pending.boundary.cancel();
            pending.item.owner.dispose();
        }
    }

    private removeCurrent(): void {
        if (this.current !== null) {
            removeItem(this.current);
            this.current = null;
        }
        this.currentKey = NONE;
    }
}

// --- Liste avec clés (t-foreach) -----------------------------------------------------------------

interface Row extends Item {
    key: unknown;
    item: Signal<unknown>;
    /** Index de la ligne (absent si le template ne lit pas `x_index`). */
    index: Signal<number> | null;
    boundary: Boundary | null;
}

function toArray(value: unknown): unknown[] {
    if (value === null || value === undefined || value === false) {
        return [];
    }
    if (Array.isArray(value)) {
        const n = value.length;
        const result = new Array(n);
        for (let i = 0; i < n; i++) {
            result[i] = value[i];
        }
        return result;
    }
    if (typeof value === "number") {
        return Array.from({ length: value }, (_, i) => i);
    }
    if (typeof value === "string") {
        return Array.from(value);
    }
    if (typeof value === "object" && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function") {
        return Array.from(value as Iterable<unknown>);
    }
    if (typeof value === "object") {
        return Object.values(value as object);
    }
    throw new Error(`[trame] t-foreach : valeur non itérable (${String(value)})`);
}

export class ListRegion extends Region {
    private rows: Row[] = [];
    private readonly owner: Owner;
    /** Sans t-key : clés de remplacement (stables) des 2e, 3e... occurrences d'une même valeur. */
    private duplicates = new Map<unknown, object[]>();

    constructor(
        anchor: Node,
        listFn: () => unknown,
        private readonly keyFn: ((item: unknown, index: number) => unknown) | null,
        private readonly rowBuilder: (item: Signal<unknown>, index: Signal<number> | null) => Root[],
        loc?: string,
        /** Le template lit-il `x_index` ? (vrai par défaut : templates précompilés plus anciens). */
        private readonly withIndex = true,
    ) {
        super(anchor);
        this.owner = requireOwner();
        renderEffect(() => {
            const items = toArray(listFn());
            const keyFn = this.keyFn;
            const keys = keyFn === null ? this.identityKeys(items) : items.map((item, i) => keyFn(item, i));
            untrack(() => this.reconcile(items, keys));
        }, loc);
    }

    firstNode(): Node {
        return this.rows.length ? itemFirst(this.rows[0]) : this.anchor;
    }

    /**
     * Sans t-key, la clé d'une ligne est sa valeur. Une valeur présente plusieurs fois reçoit, pour
     * chaque occurrence supplémentaire, une clé de remplacement stable d'une mise à jour à l'autre.
     */
    private identityKeys(items: unknown[]): unknown[] {
        const previous = this.duplicates;
        const next = new Map<unknown, object[]>();
        const counts = new Map<unknown, number>();
        const keys = new Array(items.length);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const count = counts.get(item) ?? 0;
            counts.set(item, count + 1);
            if (count === 0) {
                keys[i] = item;
                continue;
            }
            let substitutes = next.get(item);
            if (substitutes === undefined) {
                substitutes = [];
                next.set(item, substitutes);
            }
            const key = previous.get(item)?.[count - 1] ?? {};
            substitutes.push(key);
            keys[i] = key;
        }
        this.duplicates = next;
        return keys;
    }

    private reconcile(items: unknown[], keys: unknown[]): void {
        const oldRows = this.rows;
        const n = items.length;
        const byKey = new Map<unknown, Row>();
        for (let i = 0; i < oldRows.length; i++) {
            byKey.set(oldRows[i].key, oldRows[i]);
        }
        const parent = this.anchor.parentNode!;

        // Clés en double : erreur avant toute modification (la liste reste cohérente).
        const seen = new Set<unknown>();
        for (let i = 0; i < n; i++) {
            if (seen.has(keys[i])) {
                throw duplicateKey(keys[i]);
            }
            seen.add(keys[i]);
        }

        // Cas rapide : tout vider
        if (n === 0) {
            if (oldRows.length > 0 && parent.firstChild === itemFirst(oldRows[0]) && parent.lastChild === this.anchor) {
                // La liste est seule dans son parent : on vide d'un coup.
                for (const row of oldRows) {
                    row.boundary?.cancel();
                    row.owner.dispose();
                }
                parent.textContent = "";
                parent.appendChild(this.anchor);
            } else {
                for (const row of oldRows) {
                    this.removeRow(row);
                }
            }
            this.rows = [];
            return;
        }

        const newRows: Row[] = new Array(n);
        /** Position de chaque ligne réutilisée dans l'ancienne liste (-1 : nouvelle ligne). */
        const oldPositions = new Int32Array(n);
        const oldIndex = new Map<Row, number>();
        oldRows.forEach((row, i) => oldIndex.set(row, i));
        for (let i = 0; i < n; i++) {
            const key = keys[i];
            const existing = byKey.get(key);
            if (existing !== undefined) {
                byKey.delete(key);
                existing.item.set(items[i]);
                existing.index?.set(i);
                newRows[i] = existing;
                oldPositions[i] = oldIndex.get(existing)!;
            } else {
                newRows[i] = this.createRow(key, items[i], i);
                oldPositions[i] = -1;
                if (this.owner.disposed) {
                    // Une erreur de construction a fait détruire la liste (fallback d'une <ErrorBoundary>).
                    for (let j = 0; j <= i; j++) {
                        if (oldPositions[j] === -1) {
                            this.removeRow(newRows[j]);
                        }
                    }
                    return;
                }
            }
        }
        // Lignes disparues
        for (const row of byKey.values()) {
            this.removeRow(row);
        }
        // Les lignes appartenant à la plus longue sous-suite croissante restent en place ;
        // les autres sont déplacées, les nouvelles insérées (en partant de la fin).
        const stable = longestIncreasingSubsequence(oldPositions);
        let stableIndex = stable.length - 1;
        let next: Node = this.anchor;
        for (let i = n - 1; i >= 0; i--) {
            const row = newRows[i];
            if (oldPositions[i] === -1) {
                insertItem(row, parent, next);
                this.rowInserted(row);
            } else if (stableIndex >= 0 && stable[stableIndex] === i) {
                stableIndex--;
            } else {
                insertItem(row, parent, next);
            }
            next = itemFirst(row);
        }
        this.rows = newRows;
    }

    private createRow(key: unknown, value: unknown, index: number): Row {
        const item = new Signal<unknown>(value);
        const indexSig = this.withIndex ? new Signal(index) : null;
        const live = this.owner.live;
        let boundary: Boundary | null = null;
        let row!: Row;
        if (live) {
            boundary = new Boundary(
                () => this.rowReady(row),
                (error) => this.owner.handleError(error),
            );
        }
        const built = buildItem(this.owner, () => this.rowBuilder(item, indexSig), boundary ?? undefined);
        row = { roots: built.roots, owner: built.owner, placeholder: null, key, item, index: indexSig, boundary };
        if (boundary !== null) {
            if (boundary.waiting) {
                // La ligne attend une donnée : un nœud vide tient sa place jusqu'à ce qu'elle soit prête.
                row.placeholder = document.createTextNode("");
            } else {
                // Rien n'est attendu (cas courant) : la ligne sera insérée directement.
                boundary.cancel();
                row.boundary = null;
                row.owner.boundary = this.owner.boundary;
            }
        }
        return row;
    }

    private rowInserted(row: Row): void {
        if (row.boundary !== null) {
            row.boundary.done();
        } else if (row.owner.detached) {
            // Préparée hors du DOM sans rien attendre : affichée dès son insertion.
            row.owner.detached = false;
            if (this.owner.live) {
                row.owner.activate();
            }
        }
    }

    private rowReady(row: Row): void {
        const placeholder = row.placeholder;
        if (placeholder === null || row.owner.disposed) {
            return;
        }
        row.placeholder = null;
        const parent = placeholder.parentNode;
        if (parent !== null) {
            insertItem(row, parent, placeholder);
            parent.removeChild(placeholder);
        }
        row.owner.detached = false;
        if (this.owner.live) {
            row.owner.activate();
        }
    }

    private removeRow(row: Row): void {
        row.boundary?.cancel();
        removeItem(row);
    }
}

function duplicateKey(key: unknown): Error {
    return new Error(`[trame] t-foreach : clé en double (${String(key)}). Utilisez t-key avec une valeur unique.`);
}

/** Indices (dans `arr`) formant une plus longue sous-suite strictement croissante, en ignorant les -1. */
export function longestIncreasingSubsequence(arr: ArrayLike<number>): number[] {
    const n = arr.length;
    const predecessors = new Int32Array(n);
    const tails: number[] = [];
    for (let i = 0; i < n; i++) {
        const value = arr[i];
        if (value === -1) {
            continue;
        }
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[tails[mid]] < value) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        predecessors[i] = lo > 0 ? tails[lo - 1] : -1;
        tails[lo] = i;
    }
    const result: number[] = new Array(tails.length);
    let k = tails.length ? tails[tails.length - 1] : -1;
    for (let i = tails.length - 1; i >= 0; i--) {
        result[i] = k;
        k = predecessors[k];
    }
    return result;
}

// --- t-out ---------------------------------------------------------------------------------------

export class Markup {
    constructor(readonly html: string) {}

    toString(): string {
        return this.html;
    }
}

/** Marque une chaîne comme HTML sûr : t-out l'insérera sans échappement. */
export function markup(html: string): Markup {
    return new Markup(html);
}

export class OutRegion extends Region {
    private nodes: Node[] = [];

    constructor(anchor: Node, valueFn: () => unknown, loc?: string) {
        super(anchor);
        renderEffect(() => {
            const value = valueFn();
            untrack(() => this.update(value));
        }, loc);
    }

    firstNode(): Node {
        return this.nodes.length ? this.nodes[0] : this.anchor;
    }

    private update(value: unknown): void {
        const nodes = this.nodes;
        if (value === null || value === undefined || value === false) {
            this.replace([]);
            return;
        }
        if (value instanceof Markup) {
            const tpl = document.createElement("template");
            tpl.innerHTML = value.html;
            this.replace(Array.from(tpl.content.childNodes));
            return;
        }
        if (typeof Node !== "undefined" && value instanceof Node) {
            this.replace(value.nodeType === 11 ? Array.from(value.childNodes) : [value]);
            return;
        }
        const text = String(value);
        if (nodes.length === 1 && nodes[0].nodeType === 3) {
            const node = nodes[0] as Text;
            if (node.data !== text) {
                node.data = text;
            }
            return;
        }
        this.replace([document.createTextNode(text)]);
    }

    private replace(newNodes: Node[]): void {
        for (const node of this.nodes) {
            node.parentNode?.removeChild(node);
        }
        const parent = this.anchor.parentNode!;
        for (const node of newNodes) {
            parent.insertBefore(node, this.anchor);
        }
        this.nodes = newNodes;
    }
}
