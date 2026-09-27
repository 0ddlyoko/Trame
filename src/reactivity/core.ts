/**
 * Moteur réactif de Trame.
 *
 * Graphe push-pull :
 * - une écriture pousse un marquage (DIRTY sur les observateurs directs, CHECK plus loin) ;
 * - une lecture tire les valeurs : un nœud CHECK vérifie ses sources avant de décider s'il se recalcule.
 *
 * Les nœuds « vivants » (effets, et computed observés) sont abonnés à leurs sources.
 * Un computed non observé n'est abonné à rien : il se revalide à la lecture grâce aux numéros de version,
 * ce qui le rend collectable par le ramasse-miettes dès qu'on ne le référence plus.
 */

import type { Owner } from "./owner";

// --- États ---------------------------------------------------------------------------------------

const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;

export type Equals<T> = (a: T, b: T) => boolean;

const defaultEquals: Equals<unknown> = Object.is;

/** Une ressource asynchrone « en attente » (premier chargement), vue par le moteur. */
export interface PendingSource {
    /** Boundaries en attente de cette ressource. */
    waiters: Set<PendingWaiter>;
}

export interface PendingWaiter {
    resolved(source: PendingSource): void;
    failed(source: PendingSource, error: unknown): void;
}

// --- Contexte d'exécution ------------------------------------------------------------------------

/** Calcul en cours d'exécution, qui collecte ses dépendances. */
let currentObserver: Computation | null = null;
/** Version globale : incrémentée à chaque écriture. Permet la revalidation O(1) des computed froids. */
let globalVersion = 0;

export function getCurrentObserver(): Computation | null {
    return currentObserver;
}

/** Exécute `fn` sans enregistrer de dépendances. */
export function untrack<T>(fn: () => T): T {
    const prev = currentObserver;
    currentObserver = null;
    try {
        return fn();
    } finally {
        currentObserver = prev;
    }
}

// --- Sources -------------------------------------------------------------------------------------

export abstract class ReactiveNode {
    /** Incrémentée à chaque changement de valeur. */
    version = 0;
    /** Observateurs vivants. */
    observers: Set<Computation> | null = null;

    protected track(): void {
        const obs = currentObserver;
        if (obs !== null) {
            obs.addSource(this);
        }
    }

    addObserver(obs: Computation): void {
        (this.observers ??= new Set()).add(obs);
    }

    removeObserver(obs: Computation): void {
        const observers = this.observers;
        if (observers !== null) {
            observers.delete(obs);
            if (observers.size === 0) {
                this.onUnobserved();
            }
        }
    }

    get observed(): boolean {
        return this.observers !== null && this.observers.size > 0;
    }

    /** Appelé quand le dernier observateur vivant disparaît. */
    protected onUnobserved(): void {}

    /** Appelé quand une lecture veut s'assurer que la valeur est à jour. */
    updateIfNeeded(): void {}

    /** Prévient les observateurs que la valeur a changé. */
    protected notify(): void {
        this.version++;
        globalVersion++;
        const observers = this.observers;
        if (observers !== null) {
            batchDepth++;
            try {
                for (const obs of observers) {
                    obs.mark(DIRTY);
                }
            } finally {
                batchDepth--;
            }
            if (batchDepth === 0) {
                scheduleFlush();
            }
        }
    }
}

export class Signal<T> extends ReactiveNode {
    private value: T;
    private readonly equals: Equals<T>;

    constructor(value: T, equals: Equals<T> | false = defaultEquals as Equals<T>) {
        super();
        this.value = value;
        this.equals = equals === false ? () => false : equals;
    }

    get(): T {
        this.track();
        return this.value;
    }

    /** Lit la valeur sans créer de dépendance. */
    peek(): T {
        return this.value;
    }

    set(value: T): void {
        if (!this.equals(this.value, value)) {
            this.value = value;
            this.notify();
        }
    }

    /** Force la notification des observateurs (valeur mutée en place). */
    trigger(): void {
        this.notify();
    }
}

// --- Calculs -------------------------------------------------------------------------------------

export abstract class Computation extends ReactiveNode {
    state = DIRTY;
    /** Sources lues lors de la dernière exécution, avec la version vue. */
    sources: Map<ReactiveNode, number> | null = null;
    /** Sources en cours de collecte pendant l'exécution. */
    private collecting: Map<ReactiveNode, number> | null = null;
    /** Ressources en attente lues (directement ou via un computed) lors de la dernière exécution. */
    pending: Set<PendingSource> | null = null;
    private collectingPending: Set<PendingSource> | null = null;
    /** Abonné à ses sources ? */
    live = false;
    disposed = false;

    addSource(source: ReactiveNode): void {
        const collecting = this.collecting;
        if (collecting !== null && !collecting.has(source)) {
            if (source instanceof Computed && source.pending !== null) {
                for (const p of source.pending) {
                    this.addPending(p);
                }
            }
            collecting.set(source, source.version);
        }
    }

    addPending(source: PendingSource): void {
        (this.collectingPending ??= new Set()).add(source);
    }

    /** Pendant l'exécution : une ressource en attente a-t-elle été lue ? */
    hasPendingReads(): boolean {
        return this.collectingPending !== null && this.collectingPending.size > 0;
    }

    /** Hors exécution : faut-il réexécuter (une source a-t-elle vraiment changé) ? */
    needsUpdate(): boolean {
        if (this.state === CLEAN) {
            return false;
        }
        if (this.state === CHECK && !this.sourcesChanged()) {
            this.state = CLEAN;
            return false;
        }
        return true;
    }

    /** Exécute `fn` en collectant les dépendances, puis met à jour les abonnements. */
    runTracked<R>(fn: () => R): R {
        const prevObserver = currentObserver;
        const prevCollecting = this.collecting;
        const prevPending = this.collectingPending;
        this.collecting = new Map();
        this.collectingPending = null;
        currentObserver = this;
        try {
            return fn();
        } finally {
            currentObserver = prevObserver;
            const newSources = this.collecting!;
            this.pending = this.collectingPending;
            this.collecting = prevCollecting;
            this.collectingPending = prevPending;
            this.swapSources(newSources);
        }
    }

    private swapSources(newSources: Map<ReactiveNode, number>): void {
        const old = this.sources;
        this.sources = newSources;
        if (!this.live) {
            return;
        }
        if (old !== null) {
            for (const source of old.keys()) {
                if (!newSources.has(source)) {
                    source.removeObserver(this);
                }
            }
        }
        for (const source of newSources.keys()) {
            if (old === null || !old.has(source)) {
                subscribe(source, this);
            }
        }
    }

    /** Vérifie si une source a changé depuis la dernière exécution. */
    protected sourcesChanged(): boolean {
        const sources = this.sources;
        if (sources === null) {
            return true;
        }
        for (const [source, version] of sources) {
            source.updateIfNeeded();
            if (source.version !== version) {
                return true;
            }
        }
        return false;
    }

    abstract mark(state: number): void;

    protected unsubscribeAll(): void {
        const sources = this.sources;
        if (sources !== null && this.live) {
            for (const source of sources.keys()) {
                source.removeObserver(this);
            }
        }
        this.live = false;
    }
}

function subscribe(source: ReactiveNode, obs: Computation): void {
    source.addObserver(obs);
    if (source instanceof Computed && !source.live) {
        source.goLive();
    }
}

export interface ComputedOptions<T> {
    equals?: Equals<T>;
}

export type RecomputeListener = (computed: Computed<unknown>) => void;

let recomputeListener: RecomputeListener | null = null;

/** Appelé à chaque recalcul d'un computed (utilisé par le mode observation de loading()). Renvoie l'ancien. */
export function setRecomputeListener(listener: RecomputeListener | null): RecomputeListener | null {
    const prev = recomputeListener;
    recomputeListener = listener;
    return prev;
}

/** Valeur dérivée, paresseuse et mise en cache. */
export class Computed<T> extends Computation {
    private value: T | undefined = undefined;
    private error: unknown = undefined;
    private hasError = false;
    private readonly equals: Equals<T>;
    private lastGlobalVersion = -1;
    /** Recalcul forcé à la prochaine lecture (cache calculé en mode observation). */
    private forced = false;

    constructor(
        private readonly fn: () => T,
        options: ComputedOptions<T> = {},
    ) {
        super();
        this.equals = options.equals ?? (defaultEquals as Equals<T>);
    }

    get(): T {
        if (this.disposed) {
            return this.value as T;
        }
        this.updateIfNeeded();
        this.track();
        if (this.hasError) {
            throw this.error;
        }
        return this.value as T;
    }

    peek(): T {
        return untrack(() => this.get());
    }

    /** Force un recalcul à la prochaine lecture. */
    invalidate(): void {
        this.forced = true;
    }

    override updateIfNeeded(): void {
        if (this.forced) {
            this.recompute();
            return;
        }
        if (this.live) {
            if (this.state === CLEAN) {
                return;
            }
            if (this.state === CHECK && !this.sourcesChanged()) {
                this.state = CLEAN;
                return;
            }
        } else {
            // Nœud froid : revalidation par versions.
            if (this.lastGlobalVersion === globalVersion) {
                return;
            }
            if (this.sources !== null && !this.sourcesChanged()) {
                this.lastGlobalVersion = globalVersion;
                return;
            }
        }
        this.recompute();
    }

    private recompute(): void {
        this.forced = false;
        recomputeListener?.(this as Computed<unknown>);
        let value: T | undefined;
        let error: unknown;
        let failed = false;
        try {
            value = this.runTracked(this.fn);
        } catch (e) {
            error = e;
            failed = true;
        }
        this.state = CLEAN;
        this.lastGlobalVersion = globalVersion;
        if (failed) {
            if (this.pending !== null) {
                // Erreur pendant qu'une dépendance charge : on l'ignore, on recalculera à son arrivée.
                failed = false;
                value = undefined;
            } else {
                const changed = !this.hasError || this.error !== error;
                this.hasError = true;
                this.error = error;
                if (changed) {
                    this.version++;
                }
                return;
            }
        }
        const changed = this.hasError || this.version === 0 || !this.equals(this.value as T, value as T);
        this.hasError = false;
        this.error = undefined;
        if (changed) {
            this.value = value;
            this.version++;
        }
    }

    override mark(state: number): void {
        if (this.state < state) {
            const wasClean = this.state === CLEAN;
            this.state = state;
            if (wasClean && this.observers !== null) {
                for (const obs of this.observers) {
                    obs.mark(CHECK);
                }
            }
        }
    }

    goLive(): void {
        // On valide d'abord le cache (mode froid), pour partir d'un état propre. Un computed invalidé
        // (calculé en mode observation) ne se recalcule pas ici : il le fera à sa prochaine vraie lecture.
        if (this.sources !== null && !this.forced) {
            this.updateIfNeeded();
        }
        this.live = true;
        // CLEAN même si forcé : un changement de source doit encore être propagé aux observateurs.
        this.state = this.sources === null ? DIRTY : CLEAN;
        if (this.sources !== null) {
            for (const source of this.sources.keys()) {
                subscribe(source, this);
            }
        }
    }

    protected override onUnobserved(): void {
        this.unsubscribeAll();
    }

    dispose(): void {
        this.unsubscribeAll();
        this.disposed = true;
    }
}

// --- Effets et ordonnancement --------------------------------------------------------------------

/** Priorités d'exécution : les ressources relancées d'abord, puis le DOM, puis les effets utilisateur. */
export const PRIORITY_RESOURCE = 0;
export const PRIORITY_RENDER = 1;
export const PRIORITY_USER = 2;

let effectIds = 0;

export class Effect extends Computation {
    queued = false;
    readonly id = effectIds++;
    /** Localisation dans un template (messages d'erreur en mode dev). */
    loc: string | undefined = undefined;
    private cleanup: (() => void) | void = undefined;

    constructor(
        private readonly fn: () => void | (() => void),
        readonly owner: Owner | null,
        readonly priority: number = PRIORITY_USER,
    ) {
        super();
        this.live = true;
        owner?.registerEffect(this);
    }

    get depth(): number {
        return this.owner ? this.owner.depth : 0;
    }

    /** Exécute l'effet immédiatement. */
    run(): void {
        if (this.disposed) {
            return;
        }
        this.state = CLEAN;
        this.runCleanup();
        try {
            this.cleanup = this.runTracked(this.fn);
        } catch (e) {
            if (this.pending === null) {
                this.handleError(e);
            }
        }
        const pending = this.pending;
        if (pending !== null && this.owner !== null) {
            this.owner.waitFor(pending);
        }
    }

    protected handleError(e: unknown): void {
        if (this.owner !== null) {
            this.owner.handleError(annotateError(e, this.loc, this.owner));
        } else {
            reportError(e);
        }
    }

    private runCleanup(): void {
        const cleanup = this.cleanup;
        if (typeof cleanup === "function") {
            this.cleanup = undefined;
            untrack(cleanup);
        }
    }

    override mark(state: number): void {
        if (this.state < state) {
            this.state = state;
            this.schedule();
        }
    }

    schedule(): void {
        if (!this.queued && !this.disposed) {
            this.queued = true;
            queue.push(this);
            scheduleFlush();
        }
    }

    /** Clé de tri : priorité, puis profondeur (parents d'abord), puis ordre de création. */
    get sortKey(): number {
        return (this.priority * 1024 + Math.min(this.depth, 1023)) * 0x100000000 + this.id;
    }

    /** Appelé par le flush : vérifie les sources puis exécute si nécessaire. */
    update(): void {
        if (this.disposed || this.state === CLEAN) {
            return;
        }
        if (this.state === CHECK && !this.sourcesChanged()) {
            this.state = CLEAN;
            return;
        }
        this.run();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.unsubscribeAll();
        this.runCleanup();
    }
}

/** File de priorité (tas binaire) des effets à exécuter. */
class EffectQueue {
    private heap: Effect[] = [];

    get length(): number {
        return this.heap.length;
    }

    push(effect: Effect): void {
        const heap = this.heap;
        const key = effect.sortKey;
        let i = heap.length;
        heap.push(effect);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].sortKey <= key) {
                break;
            }
            heap[i] = heap[parent];
            i = parent;
        }
        heap[i] = effect;
    }

    pop(): Effect {
        const heap = this.heap;
        const top = heap[0];
        const last = heap.pop()!;
        const n = heap.length;
        if (n > 0) {
            const key = last.sortKey;
            let i = 0;
            for (;;) {
                const left = 2 * i + 1;
                if (left >= n) {
                    break;
                }
                const right = left + 1;
                const child = right < n && heap[right].sortKey < heap[left].sortKey ? right : left;
                if (heap[child].sortKey >= key) {
                    break;
                }
                heap[i] = heap[child];
                i = child;
            }
            heap[i] = last;
        }
        return top;
    }

    clear(): void {
        this.heap = [];
    }
}

const queue = new EffectQueue();
let batchDepth = 0;
let flushScheduled = false;
let flushing = false;
const afterFlushCallbacks: (() => void)[] = [];
const scheduleMicrotask: (fn: () => void) => void =
    typeof queueMicrotask === "function" ? queueMicrotask : (fn) => void Promise.resolve().then(fn);

function scheduleFlush(): void {
    if (!flushScheduled && batchDepth === 0 && !flushing) {
        flushScheduled = true;
        scheduleMicrotask(flush);
    }
}

/** Exécute tous les effets en attente, puis les callbacks « après flush ». */
export function flush(): void {
    flushScheduled = false;
    if (flushing) {
        return;
    }
    flushing = true;
    let iterations = 0;
    try {
        while (queue.length > 0 || afterFlushCallbacks.length > 0) {
            while (queue.length > 0) {
                if (++iterations > 1000000) {
                    queue.clear();
                    reportError(new Error("[trame] Boucle réactive infinie détectée (un effet modifie ses propres dépendances ?)"));
                    break;
                }
                // Toujours le plus prioritaire d'abord (parents avant enfants) : un effet peut
                // disposer ou planifier d'autres effets pendant son exécution.
                const effect = queue.pop();
                effect.queued = false;
                effect.update();
            }
            if (afterFlushCallbacks.length > 0) {
                const callbacks = afterFlushCallbacks.splice(0);
                for (const cb of callbacks) {
                    try {
                        cb();
                    } catch (e) {
                        reportError(e);
                    }
                }
            }
        }
    } finally {
        flushing = false;
    }
}

/** Regroupe plusieurs écritures : les effets s'exécutent une seule fois, à la fin, de façon synchrone. */
export function batch<T>(fn: () => T): T {
    batchDepth++;
    try {
        return fn();
    } finally {
        batchDepth--;
        if (batchDepth === 0 && !flushing && (queue.length > 0 || afterFlushCallbacks.length > 0)) {
            flush();
        }
    }
}

/**
 * Regroupe des notifications sans forcer d'exécution synchrone : les effets restent planifiés
 * au prochain microtask (sauf si l'on est déjà dans un batch, qui les exécutera à sa fin).
 * Utilisé par le store : une suite d'écritures (ex. échange de deux éléments) n'expose jamais
 * d'état intermédiaire.
 */
export function groupWrites<T>(fn: () => T): T {
    batchDepth++;
    try {
        return fn();
    } finally {
        batchDepth--;
        if (batchDepth === 0 && (queue.length > 0 || afterFlushCallbacks.length > 0)) {
            scheduleFlush();
        }
    }
}

/** Planifie `fn` après le prochain flush (ou au prochain microtask s'il n'y a rien à exécuter). */
export function afterFlush(fn: () => void): void {
    afterFlushCallbacks.push(fn);
    if (!flushing && batchDepth === 0 && !flushScheduled) {
        flushScheduled = true;
        scheduleMicrotask(flush);
    }
}

/** Promesse résolue une fois que toutes les mises à jour en attente ont été appliquées. */
export function nextTick(): Promise<void> {
    return new Promise((resolve) => afterFlush(resolve));
}

export function reportError(e: unknown): void {
    console.error(e);
}

/**
 * Mode dev : ajoute à une erreur sa localisation dans le template
 * (« template "OrderForm", ligne 12 : {{ order.total.toFixed(2) }} »).
 *
 * - `error.trameLocation` contient la localisation ;
 * - la pile d'appels (`error.stack`, affichée par la console) la mentionne juste après le message.
 *
 * Le message et le type de l'erreur ne sont pas modifiés (un <ErrorBoundary> affiche un message propre).
 * La première localisation, la plus précise, est conservée.
 */
export function annotateError(error: unknown, loc: string | undefined, owner: Owner | null): unknown {
    if (loc === undefined || !(error instanceof Error) || !owner?.app?.dev) {
        return error;
    }
    const e = error as Error & { trameLocation?: string };
    if (e.trameLocation !== undefined) {
        return error;
    }
    try {
        Object.defineProperty(e, "trameLocation", { value: loc, enumerable: false, configurable: true });
        const header = `${e.name}: ${e.message}`;
        const line = `\n    → ${loc}`;
        if (typeof e.stack === "string" && e.stack.startsWith(header)) {
            e.stack = header + line + e.stack.slice(header.length);
        } else {
            e.stack = header + line + (typeof e.stack === "string" ? "\n" + e.stack : "");
        }
    } catch {
        // Erreur figée : on la laisse telle quelle.
    }
    return error;
}

export { scheduleMicrotask };
