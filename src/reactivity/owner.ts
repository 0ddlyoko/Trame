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
    /** Erreur de rendu (liaison, effet, construction, chargement) interceptée par personne. */
    handleUncaughtError(error: unknown): void;
    /** Erreur d'action (gestionnaire d'événement) interceptée par aucun <ErrorHandler>. */
    handleActionError(error: unknown): void;
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

/** Plusieurs services différents fournis au même niveau sous une même classe parente. */
export class AmbiguousService {
    constructor(public candidates: unknown[]) {}
}

/** Champs rarement utilisés d'un scope : créés à la demande, pour garder les scopes légers. */
interface OwnerExtra {
    /** Gestionnaire d'erreurs local : renvoie true si l'erreur est prise en charge. */
    errorHandler: ((error: unknown) => boolean) | null;
    /** Gestionnaire des erreurs d'actions (<ErrorHandler>) : renvoie true si l'erreur est prise en charge. */
    actionHandler: ((error: unknown) => boolean) | null;
    /** Services fournis à ce sous-arbre, sous leur classe exacte (ou une clé explicite). */
    providers: Map<unknown, unknown> | null;
    /** Mêmes services, sous leurs classes parentes (plusieurs candidats : AmbiguousService). */
    inherited: Map<unknown, unknown> | null;
    mountCallbacks: (() => void)[] | null;
    controller: AbortController | null;
}

export class Owner {
    readonly parent: Owner | null;
    readonly depth: number;
    app: AppContext | null;
    boundary: Boundary | null;
    /** Le scope est-il affiché dans un DOM vivant ? */
    live = false;
    /** Contenu préparé mais pas encore inséré (en attente de données). */
    detached = false;
    disposed = false;

    private children: Set<Owner> | null = null;
    private effects: Effect[] | null = null;
    private cleanups: (() => void)[] | null = null;
    private extra: OwnerExtra | null = null;

    private get x(): OwnerExtra {
        return (this.extra ??= { errorHandler: null, actionHandler: null, providers: null, inherited: null, mountCallbacks: null, controller: null });
    }

    /** Gestionnaire d'erreurs local : renvoie true si l'erreur est prise en charge. */
    get errorHandler(): ((error: unknown) => boolean) | null {
        return this.extra === null ? null : this.extra.errorHandler;
    }

    set errorHandler(handler: ((error: unknown) => boolean) | null) {
        this.x.errorHandler = handler;
    }

    /** Gestionnaire des erreurs d'actions (<ErrorHandler>) : renvoie true si l'erreur est prise en charge. */
    get actionHandler(): ((error: unknown) => boolean) | null {
        return this.extra === null ? null : this.extra.actionHandler;
    }

    set actionHandler(handler: ((error: unknown) => boolean) | null) {
        this.x.actionHandler = handler;
    }

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
        const controller = (this.x.controller ??= new AbortController());
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
            (this.x.mountCallbacks ??= []).push(fn);
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
        const callbacks = this.extra === null ? null : this.extra.mountCallbacks;
        if (callbacks !== null) {
            this.extra!.mountCallbacks = null;
            for (const cb of callbacks) {
                try {
                    cb();
                } catch (e) {
                    this.handleError(e);
                }
            }
        }
    }

    /**
     * Cherche un service fourni par ce scope ou un ancêtre (le plus proche l'emporte). À un même
     * niveau, un service fourni sous sa classe exacte l'emporte sur un service dont c'est une classe parente.
     */
    lookup(key: unknown): unknown {
        let owner: Owner | null = this;
        while (owner !== null) {
            const extra = owner.extra;
            if (extra !== null) {
                if (extra.providers !== null && extra.providers.has(key)) {
                    return extra.providers.get(key);
                }
                if (extra.inherited !== null && extra.inherited.has(key)) {
                    return extra.inherited.get(key);
                }
            }
            owner = owner.parent;
        }
        return undefined;
    }

    /** Fournit `value` sous `key` (classe exacte ou clé explicite) : une seule fois par scope. */
    provide(key: unknown, value: unknown, describe: (value: unknown) => string = String): void {
        const providers = (this.x.providers ??= new Map());
        if (providers.has(key)) {
            throw new Error(
                `[trame] Service ${describe(key)} fourni deux fois au même niveau (${describe(providers.get(key))} puis ${describe(value)}). ` +
                    "Un enfant peut le redéfinir pour ses descendants ; pour modifier le service, utilisez patch().",
            );
        }
        providers.set(key, value);
    }

    /** Fournit `value` sous une de ses classes parentes. Deux services différents : injection ambiguë. */
    provideInherited(key: unknown, value: unknown): void {
        const inherited = (this.x.inherited ??= new Map());
        const existing = inherited.get(key);
        if (existing === undefined) {
            inherited.set(key, value);
        } else if (existing instanceof AmbiguousService) {
            existing.candidates.push(value);
        } else if (existing !== value) {
            inherited.set(key, new AmbiguousService([existing, value]));
        }
    }

    /** Remplace une valeur fournie (service instancié à la première demande) sous toutes ses clés. */
    replaceProvided(from: unknown, to: unknown): void {
        if (this.extra === null) {
            return;
        }
        for (const map of [this.extra.providers, this.extra.inherited]) {
            if (map === null) {
                continue;
            }
            for (const [k, v] of map) {
                if (v === from) {
                    map.set(k, to);
                } else if (v instanceof AmbiguousService) {
                    v.candidates = v.candidates.map((c) => (c === from ? to : c));
                }
            }
        }
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

    /**
     * Erreur d'une action (gestionnaire d'événement, y compris une promesse rejetée) : elle remonte au
     * <ErrorHandler> le plus proche, sans passer par les <ErrorBoundary> (le contenu reste affiché),
     * puis à l'application (onError, sinon la console ; l'application reste montée).
     */
    handleActionError(error: unknown): void {
        let owner: Owner | null = this;
        while (owner !== null) {
            const handler = owner.extra === null ? null : owner.extra.actionHandler;
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
            this.app.handleActionError(error);
        } else {
            reportError(error);
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
        if (this.extra !== null) {
            this.extra.mountCallbacks = null;
            this.extra.controller?.abort();
        }
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

    /** Des ressources en premier chargement ont-elles été lues (et sont-elles attendues) ? */
    get waiting(): boolean {
        return this.pending.size > 0;
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
