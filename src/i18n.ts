/**
 * Traductions.
 *
 * Les textes statiques des templates, ainsi que les attributs title, placeholder, alt, aria-label et
 * label, passent par la fonction de traduction. Elle est appliquée une seule fois, à la construction
 * de la partie statique d'un template : définissez-la avant le premier montage.
 *
 *   setTranslator((text) => translations[text] ?? text);
 *   _t("Enregistrer")                      // dans le code (ou dans une expression de template)
 *   <div t-translation="off">SO001</div>  // ne pas traduire un sous-arbre
 */

let translator: ((text: string) => string) | null = null;

/** Définit la fonction de traduction (null pour désactiver). */
export function setTranslator(fn: ((text: string) => string) | null): void {
    translator = fn;
}

/** Traduit un texte (renvoyé tel quel sans traducteur). */
export function _t(text: string): string {
    return translator === null ? text : translator(text);
}

/** Traduit un texte de template en conservant les blancs autour. */
export function translateTemplateText(text: string): string {
    if (translator === null) {
        return text;
    }
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    const content = match[2];
    if (!/[^\s\d.,:;!?()\-+*/%€$#@&|'"«»…]/.test(content)) {
        return text;
    }
    return match[1] + translator(content) + match[3];
}

export const TRANSLATABLE_ATTRIBUTES = new Set(["title", "placeholder", "alt", "aria-label", "label"]);
