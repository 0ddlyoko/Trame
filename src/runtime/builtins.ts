/**
 * Composants intégrés, utilisables dans tout template sans déclaration :
 *
 *   <Suspense>               son contenu s'affiche à part quand ses données sont prêtes ;
 *     <t t-set-slot="fallback">Chargement…</t>   (affiché en attendant, facultatif)
 *     ...
 *   </Suspense>
 *
 *   <ErrorBoundary>          intercepte les erreurs de son contenu ;
 *     <t t-set-slot="fallback" t-slot-scope="e">Erreur : {{ e.error.message }}
 *        <button t-on-click="e.reset">Réessayer</button></t>
 *     ...
 *   </ErrorBoundary>
 *
 *   <ErrorHandler onError="(e) => notify(e)">   reçoit les erreurs des actions de son contenu
 *     ...                    (gestionnaires d'événements, promesses rejetées) ; le contenu reste affiché
 *   </ErrorHandler>
 *
 *   <Portal target="'#modals'">   insère son contenu ailleurs dans le document.
 *     ...
 *   </Portal>
 */

import { Boundary, getOwner, Owner } from "../reactivity/owner";
import { props, t } from "../props";
import { builtinComponents, Component, type ComponentClass, type Slots } from "./component";
import { buildItem, insertItem, type Item, itemFirst, Region, removeItem, removeRange, type Root } from "./regions";

function requireOwner(): Owner {
    const owner = getOwner();
    if (owner === null) {
        throw new Error("[trame] Rendu hors d'un scope");
    }
    return owner;
}

/** Crée l'ancre d'une région dans un fragment (pour qu'elle ait un parent). */
function detachedAnchor(): Node {
    const fragment = document.createDocumentFragment();
    return fragment.appendChild(document.createTextNode(""));
}

const emptyRoots = (): Root[] => [document.createTextNode("")];

// --- Suspense ------------------------------------------------------------------------------------

class SuspenseRegion extends Region {
    private shown: Item | null = null;
    private fallback: Item | null = null;
    private readonly content: Item;

    constructor(anchor: Node, slots: Slots | null) {
        super(anchor);
        const owner = requireOwner();
        let ready = false;
        const boundary = new Boundary(
            () => {
                ready = true;
                this.showContent(owner);
            },
            (error) => owner.handleError(error),
        );
        // Détruit avant d'être prêt : on abandonne l'attente.
        owner.onCleanup(() => boundary.cancel());
        const defaultSlot = slots?.default;
        this.content = buildItem(owner, defaultSlot ? () => defaultSlot() : emptyRoots, boundary);
        boundary.done();
        if (!ready) {
            const fallbackSlot = slots?.fallback;
            if (fallbackSlot) {
                this.fallback = buildItem(owner, () => fallbackSlot());
                this.show(this.fallback);
            }
        }
    }

    private show(item: Item): void {
        insertItem(item, this.anchor.parentNode!, this.anchor);
        this.shown = item;
    }

    private showContent(owner: Owner): void {
        if (owner.disposed || this.content.owner.disposed) {
            return;
        }
        if (this.fallback !== null) {
            removeItem(this.fallback);
            this.fallback = null;
        }
        this.show(this.content);
        this.content.owner.detached = false;
        if (owner.live) {
            this.content.owner.activate();
        }
    }

    firstNode(): Node {
        return this.shown ? itemFirst(this.shown) : this.anchor;
    }
}

export class Suspense extends Component {
    static customRender = (_: Suspense, slots: Slots | null): Root[] => [new SuspenseRegion(detachedAnchor(), slots)];
}

// --- ErrorBoundary -------------------------------------------------------------------------------

class ErrorRegion extends Region {
    private item: Item | null = null;
    private building = false;
    private pendingError: unknown = undefined;
    /** Fallback affiché : les erreurs suivantes du contenu (en cours de destruction) sont ignorées. */
    private failed = false;
    private readonly holder: Owner;
    private readonly owner: Owner;

    constructor(
        anchor: Node,
        private readonly slots: Slots | null,
    ) {
        super(anchor);
        this.owner = requireOwner();
        this.holder = this.createHolder();
        this.buildContent();
    }

    private createHolder(): Owner {
        const holder = buildHolder(this.owner);
        holder.errorHandler = (error) => {
            if (this.failed) {
                return true;
            }
            if (this.building) {
                this.pendingError ??= error;
            } else {
                this.showFallback(error);
            }
            return true;
        };
        return holder;
    }

    private buildContent(): void {
        const slot = this.slots?.default;
        this.building = true;
        this.pendingError = undefined;
        try {
            this.item = buildItem(this.holder, slot ? () => slot() : emptyRoots);
        } catch (error) {
            this.pendingError ??= error;
        } finally {
            this.building = false;
        }
        if (this.pendingError !== undefined) {
            const error = this.pendingError;
            this.pendingError = undefined;
            this.item?.owner.dispose();
            this.item = null;
            this.showFallback(error);
            return;
        }
        insertItem(this.item!, this.anchor.parentNode!, this.anchor);
        if (this.owner.live) {
            this.item!.owner.activate();
        }
    }

    private showFallback(error: unknown): void {
        this.failed = true;
        if (this.item !== null) {
            removeItem(this.item);
            this.item = null;
        }
        const slot = this.slots?.fallback;
        const reset = () => this.reset();
        const builder = slot ? () => slot({ error, reset }) : () => [document.createTextNode(String(error))];
        this.item = buildItem(this.owner, builder);
        insertItem(this.item, this.anchor.parentNode!, this.anchor);
        if (this.owner.live) {
            this.item.owner.activate();
        }
    }

    private reset(): void {
        this.failed = false;
        if (this.item !== null) {
            removeItem(this.item);
            this.item = null;
        }
        this.buildContent();
    }

    firstNode(): Node {
        return this.item ? itemFirst(this.item) : this.anchor;
    }
}

/** Scope intermédiaire qui porte le gestionnaire d'erreurs du contenu. */
function buildHolder(parent: Owner): Owner {
    return new Owner(parent);
}

export class ErrorBoundary extends Component {
    static customRender = (_: ErrorBoundary, slots: Slots | null): Root[] => [new ErrorRegion(detachedAnchor(), slots)];
}

// --- ErrorHandler --------------------------------------------------------------------------------

class ErrorHandlerRegion extends Region {
    private readonly item: Item;

    constructor(anchor: Node, component: ErrorHandler, slots: Slots | null) {
        super(anchor);
        const holder = new Owner(requireOwner());
        holder.actionHandler = (error) => {
            component.props.onError(error);
            return true;
        };
        const slot = slots?.default;
        this.item = buildItem(holder, slot ? () => slot() : emptyRoots);
        insertItem(this.item, this.anchor.parentNode!, this.anchor);
    }

    firstNode(): Node {
        return itemFirst(this.item);
    }
}

/**
 * Reçoit les erreurs des actions de son contenu (gestionnaires d'événements, y compris les promesses
 * rejetées) : `onError` est appelé et le contenu reste affiché. Les erreurs de rendu (liaisons, effets,
 * construction, chargement) ne passent pas par lui : elles vont à <ErrorBoundary>.
 */
export class ErrorHandler extends Component {
    static customRender = (component: ErrorHandler, slots: Slots | null): Root[] => [new ErrorHandlerRegion(detachedAnchor(), component, slots)];
    props = props({ onError: t.func<(error: unknown) => void>() });
}

// --- Portal --------------------------------------------------------------------------------------

class PortalRegion extends Region {
    constructor(anchor: Node, component: Portal, slots: Slots | null) {
        super(anchor);
        const owner = requireOwner();
        const slot = slots?.default;
        const item = buildItem(owner, slot ? () => slot() : emptyRoots);
        owner.onMount(() => {
            const target = (component as unknown as { props: { target?: unknown } }).props.target;
            const el = typeof target === "string" ? document.querySelector(target) : target;
            if (!(el instanceof Element)) {
                throw new Error(`[trame] <Portal> : cible introuvable (${String(target)})`);
            }
            insertItem(item, el, null);
        });
        owner.onCleanup(() => removeRange(itemFirst(item), lastNode(item)));
    }

    firstNode(): Node {
        return this.anchor;
    }
}

function lastNode(item: Item): Node {
    const last = item.roots[item.roots.length - 1];
    return last instanceof Region ? last.anchor : last;
}

export class Portal extends Component {
    static customRender = (component: Portal, slots: Slots | null): Root[] => [new PortalRegion(detachedAnchor(), component, slots)];
}

builtinComponents.Suspense = Suspense as ComponentClass;
builtinComponents.ErrorBoundary = ErrorBoundary as ComponentClass;
builtinComponents.ErrorHandler = ErrorHandler as unknown as ComponentClass;
builtinComponents.Portal = Portal as ComponentClass;
