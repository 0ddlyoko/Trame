/**
 * Registres : collections ordonnées et réactives, enrichies par les modules.
 *
 *   registry.category("fields").add("char", CharField);
 *   registry.category("fields").add("monetary", MonetaryField, { sequence: 10 });
 *   registry.category("fields").get("char");
 *   registry.category("fields").getAll();     // triés par séquence, puis ordre d'ajout
 *
 * Lire un registre (get, has, getAll...) dans un template ou un @computed abonne à ses changements.
 */

import { Signal } from "./reactivity/core";

interface Entry<T> {
    value: T;
    sequence: number;
    order: number;
}

export interface AddOptions {
    /** Ordre dans getAll() (croissant). Défaut : 50. */
    sequence?: number;
    /** Remplace une entrée existante au lieu de lever une erreur. */
    force?: boolean;
}

let insertionOrder = 0;

export class Registry<T = unknown> {
    private readonly entries = new Map<string, Entry<T>>();
    private readonly categories = new Map<string, Registry<unknown>>();
    private readonly version = new Signal(0);
    private sorted: [string, T][] | null = null;

    constructor(readonly name = "registry") {}

    add(key: string, value: T, options: AddOptions = {}): this {
        if (this.entries.has(key) && !options.force) {
            throw new Error(`[trame] Registre "${this.name}" : la clé "${key}" existe déjà (utilisez { force: true } pour la remplacer)`);
        }
        const previous = this.entries.get(key);
        this.entries.set(key, {
            value,
            sequence: options.sequence ?? previous?.sequence ?? 50,
            order: previous?.order ?? insertionOrder++,
        });
        this.changed();
        return this;
    }

    get(key: string): T;
    get<D>(key: string, defaultValue: D): T | D;
    get(key: string, ...rest: unknown[]): unknown {
        this.version.get();
        const entry = this.entries.get(key);
        if (entry === undefined) {
            if (rest.length) {
                return rest[0];
            }
            throw new Error(`[trame] Registre "${this.name}" : clé "${key}" introuvable`);
        }
        return entry.value;
    }

    has(key: string): boolean {
        this.version.get();
        return this.entries.has(key);
    }

    remove(key: string): void {
        if (this.entries.delete(key)) {
            this.changed();
        }
    }

    /** Valeurs triées par séquence. */
    getAll(): T[] {
        return this.getEntries().map(([, value]) => value);
    }

    /** Paires [clé, valeur] triées par séquence. */
    getEntries(): [string, T][] {
        this.version.get();
        if (this.sorted === null) {
            this.sorted = Array.from(this.entries)
                .sort(([, a], [, b]) => a.sequence - b.sequence || a.order - b.order)
                .map(([key, entry]) => [key, entry.value]);
        }
        return this.sorted.slice();
    }

    get size(): number {
        this.version.get();
        return this.entries.size;
    }

    /** Sous-registre nommé (créé à la demande). */
    category<C = unknown>(name: string): Registry<C> {
        let sub = this.categories.get(name);
        if (sub === undefined) {
            sub = new Registry<unknown>(`${this.name}.${name}`);
            this.categories.set(name, sub);
        }
        return sub as Registry<C>;
    }

    private changed(): void {
        this.sorted = null;
        this.version.set(this.version.peek() + 1);
    }
}

/** Registre global de l'application. */
export const registry = new Registry("registry");
