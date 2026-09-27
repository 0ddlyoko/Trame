/**
 * Arbre de propriété (scopes).
 *
 * Chaque composant, chaque branche de t-if, chaque ligne de t-foreach possède un Owner.
 * Il enregistre les effets et nettoyages créés en son sein, et libère tout quand il est détruit :
 * effets, sous-scopes, callbacks de nettoyage, AbortSignal.
 *
 * Il porte aussi le contexte hérité : services fournis (@provide), gestionnaire d'erreurs,
 * frontière d'attente (Boundary) et application.
 */

import { afterFlush, Effect, type PendingSource, type PendingWaiter, reportError, untrack } from "./core";

export interface AppContext {
    readonly dev: boolean;
    handleUncaughtError(error: unknown): void;
}

let currentOwner: Owner | null = null;

export function getOwner(): Owner | null {
    return currentOwner;
}

export function runWithOwner<T>(owner: Owner | null, fn: () => T): T {
    const prev = currentOwner;
    currentOwner = owner;
    try {
        return fn();
    } finally {
        currentOwner = prev;
    }
}

/** Enregistre un nettoyage sur le scope courant. */
export function onCleanup(fn: () => void): void {
    currentOwner?.onCleanup(fn);
}

export class Owner {
    readonly parent: Owner | null;
    readonly depth: number;
    app: AppContext | null;
    boundary: Boundary | null;
    /** Gestionnaire d'erreurs local : renvoie true si l'erreur est prise en charge. */
    errorHandler: ((error: unknown) => boolean) | null = null;
    /** Services fournis à ce sous-arbre. */
    providers: Map<unknown, unknown> | null = null;
    /** Le scope est-il affiché dans un DOM vivant ? */
    live = false;
    /** Contenu préparé mais pas encore inséré (en attente de données). */
    detached = false;
    disposed = false;

    private children: Set<Owner> | null = null;
    private effects: Effect[] | null = null;
    private cleanups: (() => void)[] | null = null;
    private mountCallbacks: (() => void)[] | null = null;
    private controller: AbortController | null = null;

    constructor(parent: Owner | null = currentOwner) {
        this.parent = parent;
        this.depth = parent ? parent.depth + 1 : 0;
        this.app = parent ? parent.app : null;
        this.boundary = parent ? parent.boundary : null;
        if (parent) {
            if (parent.disposed) {
                this.disposed = true;
            } else {
                (parent.children ??= new Set()).add(this);
            }
        }
    }

    /** AbortSignal déclenché à la destruction du scope. */
    get abortSignal(): AbortSignal {
        const controller = (this.controller ??= new AbortController());
        if (this.disposed && !controller.signal.aborted) {
            controller.abort();
        }
        return controller.signal;
    }

    registerEffect(effect: Effect): void {
        if (this.disposed) {
            effect.dispose();
            return;
        }
        (this.effects ??= []).push(effect);
    }

    onCleanup(fn: () => void): void {
        if (this.disposed) {
            untrack(fn);
            return;
        }
        (this.cleanups ??= []).push(fn);
    }

    /** Exécute `fn` quand le scope sera affiché (immédiatement s'il l'est déjà). */
    onMount(fn: () => void): void {
        if (this.disposed) {
            return;
        }
        if (this.live) {
            fn();
        } else {
            (this.mountCallbacks ??= []).push(fn);
        }
    }

    /** Marque le scope (et ses enfants insérés) comme affiché, et déclenche les callbacks onMount. */
    activate(): void {
        if (this.live || this.disposed || this.detached) {
            return;
        }
        // Enfants d'abord, comme pour un montage classique.
        if (this.children !== null) {
            for (const child of this.children) {
                child.activate();
            }
        }
        this.live = true;
        const callbacks = this.mountCallbacks;
        if (callbacks !== null) {
            this.mountCallbacks = null;
            for (const cb of callbacks) {
                try {
                    cb();
                } catch (e) {
                    this.handleError(e);
                }
            }
        }
    }

    /** Cherche un service fourni par ce scope ou un ancêtre. */
    lookup(key: unknown): unknown {
        let owner: Owner | null = this;
        while (owner !== null) {
            const providers = owner.providers;
            if (providers !== null && providers.has(key)) {
                return providers.get(key);
            }
            owner = owner.parent;
        }
        return undefined;
    }

    provide(key: unknown, value: unknown): void {
        (this.providers ??= new Map()).set(key, value);
    }

    /** Signale à la frontière d'attente les ressources lues pendant leur premier chargement. */
    waitFor(pending: Set<PendingSource>): void {
        const boundary = this.boundary;
        if (boundary !== null) {
            for (const source of pending) {
                boundary.wait(source, this);
            }
        }
    }

    handleError(error: unknown): void {
        let owner: Owner | null = this;
        while (owner !== null) {
            const handler = owner.errorHandler;
            if (handler !== null && !owner.disposed) {
                try {
                    if (handler(error)) {
                        return;
                    }
                } catch (e) {
                    error = e;
                }
            }
            owner = owner.parent;
        }
        if (this.app !== null) {
            this.app.handleUncaughtError(error);
        } else {
            reportError(error);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.live = false;
        if (this.children !== null) {
            const children = Array.from(this.children);
            this.children = null;
            for (let i = children.length - 1; i >= 0; i--) {
                children[i].dispose();
            }
        }
        if (this.effects !== null) {
            const effects = this.effects;
            this.effects = null;
            for (let i = effects.length - 1; i >= 0; i--) {
                effects[i].dispose();
            }
        }
        if (this.cleanups !== null) {
            const cleanups = this.cleanups;
            this.cleanups = null;
            for (let i = cleanups.length - 1; i >= 0; i--) {
                try {
                    untrack(cleanups[i]);
                } catch (e) {
                    reportError(e);
                }
            }
        }
        this.mountCallbacks = null;
        this.controller?.abort();
        this.parent?.children?.delete(this);
    }
}

/**
 * Frontière d'attente : compte les ressources en premier chargement lues pendant la construction
 * d'un sous-arbre, et prévient quand tout est prêt (ou quand l'une d'elles échoue).
 */
export class Boundary implements PendingWaiter {
    private readonly pending = new Set<PendingSource>();
    /** Premier scope ayant lu chaque ressource attendue : il reçoit l'erreur si elle échoue. */
    private readonly readers = new Map<PendingSource, Owner>();
    private building = true;
    settled = false;
    private closed = false;

    constructor(
        private readonly onReady: () => void,
        private readonly onError: (error: unknown) => void,
    ) {}

    get isPending(): boolean {
        return !this.settled;
    }

    wait(source: PendingSource, reader?: Owner): void {
        if (this.settled || this.closed || this.pending.has(source)) {
            return;
        }
        this.pending.add(source);
        if (reader !== undefined) {
            this.readers.set(source, reader);
        }
        source.waiters.add(this);
    }

    resolved(source: PendingSource): void {
        this.readers.delete(source);
        if (this.pending.delete(source)) {
            this.scheduleCheck();
        }
    }

    /**
     * Une ressource attendue a échoué : l'erreur est transmise au scope qui l'a lue (une
     * <ErrorBoundary> englobante peut ainsi l'intercepter), puis l'attente continue pour le reste.
     */
    failed(source: PendingSource, error: unknown): void {
        if (!this.pending.has(source) || this.closed) {
            return;
        }
        this.pending.delete(source);
        const reader = this.readers.get(source);
        this.readers.delete(source);
        if (reader === undefined || reader.disposed) {
            this.cancel();
            this.onError(error);
            return;
        }
        reader.handleError(error);
        this.scheduleCheck();
    }

    private scheduleCheck(): void {
        if (this.pending.size === 0 && !this.building && !this.closed) {
            afterFlush(() => this.check());
        }
    }

    /** La construction synchrone est terminée : on peut devenir prêt dès que plus rien n'est attendu. */
    done(): void {
        this.building = false;
        this.check();
    }

    private check(): void {
        if (!this.settled && !this.closed && !this.building && this.pending.size === 0) {
            this.settled = true;
            this.onReady();
        }
    }

    /** Abandonne l'attente (contenu détruit avant d'être prêt). */
    cancel(): void {
        this.closed = true;
        for (const source of this.pending) {
            source.waiters.delete(this);
        }
        this.pending.clear();
        this.readers.clear();
    }
}
