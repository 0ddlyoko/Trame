/**
 * Ressources asynchrones (computed asynchrones).
 *
 * - Paresseuses : rien n'est chargé tant que la valeur n'est pas lue.
 * - Une lecture pendant le premier chargement renvoie `undefined` sans interrompre l'exécution,
 *   et signale la ressource « en attente » à la frontière (Boundary) du lecteur : l'affichage attend.
 * - Dépendances : avec une source explicite (`load(source, fetcher)`), seules les valeurs lues par la
 *   source sont suivies, et le fetcher reçoit sa valeur. Sans source, ce que le fetcher lit dans sa
 *   partie synchrone (avant le premier `await`) est suivi. Si une dépendance change, la ressource est
 *   relancée (immédiatement si elle est observée, sinon à la prochaine lecture). La requête
 *   précédente est annulée via AbortSignal.
 * - Pendant un rechargement, l'ancienne valeur reste visible. Les ressources relancées par le même
 *   changement forment une transition : leurs nouvelles valeurs sont appliquées ensemble.
 * - Une requête lancée va jusqu'au bout même si plus personne ne lit la valeur. Elle n'est annulée
 *   que si elle est remplacée (dépendance modifiée, refresh) ou si le scope propriétaire est détruit.
 */

import {
    batch,
    Computation,
    Computed,
    Effect,
    getCurrentObserver,
    groupWrites,
    type PendingSource,
    type PendingWaiter,
    PRIORITY_RESOURCE,
    type ReactiveNode,
    reportError,
    scheduleMicrotask,
    setRecomputeListener,
    Signal,
    untrack,
} from "./core";
import type { Owner } from "./owner";

export interface ResourceContext {
    /** Déclenché si la requête est remplacée ou si le propriétaire est détruit. */
    readonly signal: AbortSignal;
}

export type Fetcher<T> = (ctx: ResourceContext) => Promise<T> | T;

/** Fetcher d'une ressource à source explicite : reçoit la valeur de la source. */
export type SourcedFetcher<S, T> = (value: S, ctx: ResourceContext) => Promise<T> | T;

export interface ResourceOptions {
    /** Charge dès la création au lieu d'attendre la première lecture. */
    eager?: boolean;
}

export function isAbortError(e: unknown): boolean {
    return e !== null && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";
}

/** Signal de valeur d'une ressource, reconnaissable lors des parcours du graphe. */
class ResourceSignal<T> extends Signal<T | undefined> {
    constructor(readonly resource: Resource<T>) {
        super(undefined, false);
    }
}

// --- Transitions ---------------------------------------------------------------------------------

interface TransitionMember {
    done: boolean;
    value: unknown;
}

/** Groupe de ressources relancées par un même changement : leurs valeurs sont appliquées ensemble. */
class Transition {
    private readonly members = new Map<Resource<unknown>, TransitionMember>();
    private closed = false;

    add(resource: Resource<unknown>): void {
        this.members.set(resource, { done: false, value: undefined });
    }

    resolve(resource: Resource<unknown>, value: unknown): void {
        const member = this.members.get(resource);
        if (member !== undefined) {
            member.done = true;
            member.value = value;
            this.check();
        }
    }

    drop(resource: Resource<unknown>): void {
        if (this.members.delete(resource)) {
            this.check();
        }
    }

    close(): void {
        this.closed = true;
        this.check();
    }

    private check(): void {
        if (!this.closed || this.members.size === 0) {
            return;
        }
        for (const member of this.members.values()) {
            if (!member.done) {
                return;
            }
        }
        const entries = Array.from(this.members);
        this.members.clear();
        batch(() => {
            for (const [resource, member] of entries) {
                resource.commitFromTransition(member.value);
            }
        });
    }
}

let openTransition: Transition | null = null;

function currentTransition(): Transition {
    if (openTransition === null) {
        const transition = new Transition();
        openTransition = transition;
        scheduleMicrotask(() => {
            if (openTransition === transition) {
                openTransition = null;
            }
            transition.close();
        });
    }
    return openTransition;
}

// --- Ressource -----------------------------------------------------------------------------------

/** Effet interne qui suit les dépendances du fetcher. */
class ResourceTracker extends Effect {
    constructor(private readonly resource: Resource<unknown>, owner: Owner | null) {
        super(() => resource.execute(), owner, PRIORITY_RESOURCE);
    }

    override mark(state: number): void {
        if (this.state < state) {
            this.state = state;
            this.resource.onDependenciesChanged();
        }
    }
}

export class Resource<T> implements PendingSource {
    readonly waiters = new Set<PendingWaiter>();
    private readonly valueSig = new ResourceSignal<T>(this);
    private readonly loadingSig = new Signal(false);
    private readonly errorSig = new Signal<unknown>(undefined);
    private hasValue = false;
    private stale = true;
    private runId = 0;
    private controller: AbortController | null = null;
    private unlinkOwner: (() => void) | null = null;
    private tracker: ResourceTracker | null = null;
    private transition: Transition | null = null;
    private disposed = false;

    constructor(fetcher: Fetcher<T>, owner: Owner | null, options?: ResourceOptions);
    /** Source explicite des dépendances : `fetcher` reçoit sa valeur et n'est pas suivi. */
    constructor(fetcher: SourcedFetcher<never, T>, owner: Owner | null, options: ResourceOptions, source: () => unknown);
    constructor(
        private readonly fetcher: Fetcher<T> | SourcedFetcher<never, T>,
        private readonly owner: Owner | null,
        private readonly options: ResourceOptions = {},
        private readonly source: (() => unknown) | null = null,
    ) {
        owner?.onCleanup(() => this.dispose());
        if (options.eager) {
            this.start();
        }
    }

    /** Lecture de la valeur : déclenche le chargement si nécessaire. */
    read(): T | undefined {
        const observer = getCurrentObserver();
        if (observing > 0) {
            // Observation (loading/error/refresh), y compris à travers un computed : ne charge rien.
            return this.valueSig.get();
        }
        if (this.stale && !this.disposed && (this.tracker === null || this.tracker.needsUpdate() || !this.hasValue)) {
            this.start();
        }
        this.stale = false;
        const value = this.valueSig.get();
        if (!this.hasValue && observer !== null && this.loadingSig.peek()) {
            observer.addPending(this);
        }
        return value;
    }

    /** Écriture locale (mise à jour optimiste) : aucune requête n'est lancée. */
    write(value: T): void {
        const firstValue = !this.hasValue;
        groupWrites(() => {
            this.hasValue = true;
            this.valueSig.set(value);
        });
        if (firstValue) {
            this.notifyWaiters();
        }
    }

    isLoading(): boolean {
        return this.loadingSig.get();
    }

    getError(): unknown {
        return this.errorSig.get();
    }

    /** Relance la requête. */
    refresh(): void {
        if (!this.disposed) {
            this.start();
        }
    }

    private get observed(): boolean {
        return this.valueSig.observed || this.loadingSig.observed || this.errorSig.observed;
    }

    onDependenciesChanged(): void {
        if (this.disposed) {
            return;
        }
        if (this.observed || this.options.eager) {
            this.tracker!.schedule();
        } else {
            this.stale = true;
        }
    }

    private start(): void {
        this.stale = false;
        this.tracker ??= new ResourceTracker(this as Resource<unknown>, this.owner);
        this.tracker.run();
    }

    /** Exécuté par le tracker, dans un contexte qui suit les dépendances. */
    execute(): void {
        if (this.disposed) {
            return;
        }
        const id = ++this.runId;
        this.abortCurrent();
        this.transition?.drop(this as Resource<unknown>);
        this.transition = null;

        const controller = new AbortController();
        this.controller = controller;
        const owner = this.owner;
        if (owner !== null) {
            const ownerSignal = owner.abortSignal;
            if (ownerSignal.aborted) {
                controller.abort();
            } else {
                const onAbort = () => controller.abort();
                ownerSignal.addEventListener("abort", onAbort);
                this.unlinkOwner = () => ownerSignal.removeEventListener("abort", onAbort);
            }
        }

        const tracker = this.tracker!;
        const wasLoaded = this.hasValue;
        this.loadingSig.set(true);
        this.errorSig.set(undefined);

        let result: Promise<T> | T;
        const ctx: ResourceContext = { signal: controller.signal };
        try {
            if (this.source !== null) {
                const value = this.source();
                if (tracker.hasPendingReads()) {
                    // La source lit une donnée pas encore chargée : on réessaiera à son arrivée.
                    return;
                }
                const fetcher = this.fetcher as unknown as SourcedFetcher<unknown, T>;
                result = untrack(() => fetcher(value, ctx));
            } else {
                result = (this.fetcher as Fetcher<T>)(ctx);
            }
        } catch (e) {
            if (tracker.hasPendingReads()) {
                // Une dépendance asynchrone n'est pas encore là : on réessaiera à son arrivée.
                throw e;
            }
            this.fail(id, e);
            return;
        }
        if (result !== null && typeof result === "object" && typeof (result as Promise<T>).then === "function") {
            // Une dépendance asynchrone lue avant le premier await n'est pas encore là : un rejet
            // de cette exécution n'est pas une vraie erreur, on réessaiera quand elle arrivera.
            const waitingOnDependency = tracker.hasPendingReads();
            if (wasLoaded && !waitingOnDependency) {
                const transition = currentTransition();
                transition.add(this as Resource<unknown>);
                this.transition = transition;
            }
            if (waitingOnDependency) {
                (result as Promise<T>).then(undefined, () => {});
                return;
            }
            (result as Promise<T>).then(
                (value) => this.settle(id, value),
                (error) => this.fail(id, error),
            );
        } else {
            this.settle(id, result as T);
        }
    }

    private settle(id: number, value: T): void {
        if (id !== this.runId || this.disposed) {
            return;
        }
        if (this.transition !== null) {
            this.transition.resolve(this as Resource<unknown>, value);
        } else {
            this.commit(value);
        }
    }

    commitFromTransition(value: unknown): void {
        this.transition = null;
        this.commit(value as T);
    }

    private commit(value: T): void {
        this.releaseController();
        const firstValue = !this.hasValue;
        batch(() => {
            this.hasValue = true;
            this.valueSig.set(value);
            this.loadingSig.set(false);
        });
        if (firstValue) {
            this.notifyWaiters();
        }
    }

    private fail(id: number, error: unknown): void {
        if (id !== this.runId || this.disposed) {
            return;
        }
        this.releaseController();
        this.transition?.drop(this as Resource<unknown>);
        this.transition = null;
        // Annulation non demandée par Trame (ex. délai dépassé dans le fetcher) : si l'affichage
        // attend cette donnée, c'est une vraie erreur ; sinon on revient simplement au repos.
        if (isAbortError(error) && this.waiters.size === 0) {
            this.loadingSig.set(false);
            return;
        }
        batch(() => {
            this.errorSig.set(error);
            this.loadingSig.set(false);
        });
        if (this.waiters.size > 0) {
            const waiters = Array.from(this.waiters);
            this.waiters.clear();
            for (const waiter of waiters) {
                waiter.failed(this, error);
            }
        } else if (!this.errorSig.observed) {
            reportError(error);
        }
    }

    private notifyWaiters(): void {
        if (this.waiters.size > 0) {
            const waiters = Array.from(this.waiters);
            this.waiters.clear();
            for (const waiter of waiters) {
                waiter.resolved(this);
            }
        }
    }

    private releaseController(): void {
        this.unlinkOwner?.();
        this.unlinkOwner = null;
        this.controller = null;
    }

    private abortCurrent(): void {
        const controller = this.controller;
        this.releaseController();
        controller?.abort();
    }

    /**
     * Les boundaries qui attendaient cette ressource cessent de l'attendre : détruite (ex. par le
     * fallback d'une <ErrorBoundary>, parfois au milieu de son propre commit), elle ne chargera plus,
     * et un montage en attente resterait bloqué sans erreur.
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.runId++;
        this.abortCurrent();
        this.transition?.drop(this as Resource<unknown>);
        this.transition = null;
        this.tracker?.dispose();
        this.notifyWaiters();
    }
}

// --- Observation : loading / error / refresh -----------------------------------------------------

/** Calcul temporaire qui évalue une expression en mode observation : les ressources lues ne chargent pas. */
class PeekComputation extends Computation {
    override mark(): void {}
}

/** Profondeur d'observation en cours (loading/error/refresh). */
let observing = 0;

/** Évalue `fn` en observation et renvoie les ressources impliquées, dans l'ordre de lecture. */
function collectResources(fn: () => unknown): Resource<unknown>[] {
    if (typeof fn !== "function") {
        throw new TypeError(
            "[trame] loading()/error()/refresh() attendent une fonction en TypeScript : loading(() => this.order). " +
                "Dans les templates, écrivez simplement loading(order).",
        );
    }
    const peek = new PeekComputation();
    // Les computed recalculés pendant l'observation ont pu lire des ressources sans les charger :
    // leur résultat ne doit pas rester en cache.
    const recomputed: Computed<unknown>[] = [];
    const prevListener = setRecomputeListener((c) => recomputed.push(c));
    observing++;
    try {
        peek.runTracked(fn);
    } catch {
        // Une erreur pendant l'observation (valeur pas encore chargée) n'a pas d'importance.
    } finally {
        observing--;
        setRecomputeListener(prevListener);
    }
    const outer = getCurrentObserver();
    if (outer !== null) {
        // Le lecteur doit être réévalué si l'expression observée change.
        peek.forEachSource((source) => outer.addSource(source));
    }
    const found: Resource<unknown>[] = [];
    const seen = new Set<ReactiveNode>();
    const walk = (node: ReactiveNode): void => {
        if (seen.has(node)) {
            return;
        }
        seen.add(node);
        if (node instanceof ResourceSignal) {
            found.push(node.resource);
        } else if (node instanceof Computed) {
            node.forEachSource(walk);
        }
    };
    peek.forEachSource(walk);
    for (const c of recomputed) {
        c.invalidate();
    }
    return found;
}

/** Vrai si une des ressources lues par `fn` est en cours de chargement. Ne déclenche aucun chargement. */
export function loading(fn: () => unknown): boolean {
    let result = false;
    for (const resource of collectResources(fn)) {
        if (resource.isLoading()) {
            result = true;
        }
    }
    return result;
}

/** Première erreur d'une des ressources lues par `fn` (ou undefined). */
export function error(fn: () => unknown): unknown {
    let result: unknown = undefined;
    for (const resource of collectResources(fn)) {
        const e = resource.getError();
        if (result === undefined && e !== undefined) {
            result = e;
        }
    }
    return result;
}

/** Relance la dernière ressource lue par `fn` (par ex. refresh(() => this.order.partner) relance partner). */
export function refresh(fn: () => unknown): void {
    const resources = untrack(() => collectResources(fn));
    resources[resources.length - 1]?.refresh();
}
