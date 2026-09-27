# Trame

Framework TypeScript réactif à base de signaux, pensé pour un ERP modulaire.

- **Réactivité fine** : quand une valeur change, seul le nœud DOM qui l'affiche est mis à jour. Pas de re-rendu de composant, pas de DOM virtuel, pas de fibers.
- **Un seul système** : l'état se déclare avec des décorateurs (`@state`, `@computed`, `@resource`, `@effect`).
- **Asynchrone intégré** : les données sont chargées à la première lecture, et l'affichage attend qu'elles soient prêtes. Pas de `onWillStart`.
- **Templates XML compilés** (syntaxe inspirée de QWeb), extensibles par xpath depuis d'autres modules.
- **Extensibilité** : `patch()` de n'importe quelle classe avec `super`, registres, services injectés.

Les choix de conception et leurs raisons sont détaillés dans [docs/design.md](docs/design.md).

## Démarrage

Prérequis : Node.js ≥ 20.

```bash
npm install
npm test            # tests (Vitest + jsdom)
npm run typecheck   # vérification TypeScript 7
npm run build       # dist/trame.js (ESM), dist/trame.min.js, dist/trame.iife.js, dist/types/
npm run example     # démo « commande » sur http://localhost:8000
```

Fichiers produits par `npm run build` (modules ES compatibles ES2019 : Chrome 73+, Firefox 67+, Safari 12.1+, Edge 79+) :

| Fichier | Contenu |
|---|---|
| `dist/trame.js` (`.min.js`) | Version complète : les templates sont compilés dans le navigateur au premier affichage. |
| `dist/trame.runtime.js` (`.min.js`) | Sans compilateur de templates (47 Ko minifié au lieu de 78 Ko) : les templates doivent être précompilés. |
| `dist/trame-compiler.js` | Compilateur de templates autonome (variable globale `TrameCompiler`), à exécuter côté serveur (par exemple QuickJS dans le serveur Rust). `dist/compiler.js` : même chose en module ES. |
| `dist/testing.js` | Utilitaires de test (`trame/testing`). |
| `dist/trame-check.mjs` | Vérification des templates par TypeScript (`npx trame-check`). |
| `dist/types/` | Déclarations TypeScript. |

**Configuration TypeScript requise côté ERP.** Les décorateurs sont les décorateurs standards (TS ≥ 5) :

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",                 // ou plus récent
    "useDefineForClassFields": true,    // valeur par défaut à partir de ES2022
    "experimentalDecorators": false     // surtout pas : ce sont les anciens décorateurs
  }
}
```

## Exemple

```ts
import { Component, load, mount, props, resource, state, t, xml } from "trame";

class OrderForm extends Component {
    static template = xml`
        <div>
            <h1>{{ order.name }} <small t-if="loading(order)">rechargement…</small></h1>
            <ul>
                <li t-foreach="order.lines" t-as="line" t-key="line.id">
                    {{ line.product }} : {{ line.total.toFixed(2) }} €
                </li>
            </ul>
            <button t-on-click="save" t-att-disabled="saving">Enregistrer</button>
        </div>`;

    props = props({ orderId: t.number() });

    @state accessor saving = false;
    @resource accessor order = load(({ signal }) => fetchOrder(this.props.orderId, signal));

    async save() {
        this.saving = true;
        try {
            await saveOrder(this.order);
        } finally {
            this.saving = false;
        }
    }
}

await mount(OrderForm, document.body, { props: { orderId: 42 }, dev: true });
```

Voir aussi [examples/order](examples/order) : modèles réactifs (`Order`, `OrderLine`), composant ligne, formulaire, faux backend.

## Réactivité

| Déclaration | Rôle |
|---|---|
| `@state accessor x = 1` | État réactif. Les objets, tableaux, `Map` et `Set` sont réactifs en profondeur. |
| `@computed get total() {…}` | Valeur dérivée : paresseuse, mise en cache, recalculée seulement si une dépendance lue a changé. |
| `@resource accessor order = load(fetcher)` | Donnée asynchrone (voir ci-dessous). |
| `@effect draw() {…}` | Effet de bord. Il s'exécute après le montage (pour un composant), puis à chaque changement de ce qu'il lit. Il peut renvoyer une fonction de nettoyage. |

Ces décorateurs fonctionnent dans les composants, les services et n'importe quelle classe :

```ts
class OrderLine {
    @state accessor price = 0;
    @state accessor quantity = 1;
    @computed get total() { return this.price * this.quantity; }
}
```

Les mises à jour sont regroupées et appliquées au microtask suivant. Dans un gestionnaire d'événement, le DOM est à jour dès que le gestionnaire se termine. `batch(fn)` force une application synchrone, et `await nextTick()` attend la fin des mises à jour (pratique dans les tests).

`JSON.stringify(obj)` inclut les champs `@state` : un `toJSON()` est fourni automatiquement.

## Données asynchrones

```ts
@resource accessor order = load(({ signal }) => fetchOrder(this.props.orderId, signal));
```

- **Paresseuse** : rien n'est chargé tant que la valeur n'est pas lue. Une donnée lue seulement dans un onglet fermé n'est jamais chargée.
- **Attente avant affichage** : un composant ou un bloc qui lit une donnée pas encore chargée est préparé hors du DOM, puis inséré d'un coup quand toutes ses données sont là. La lecture n'interrompt rien : elle renvoie `undefined`, et plusieurs données partent donc en parallèle. Un template peut écrire `order.name` sans précaution.
- **Dépendances** : ce que le fetcher lit **avant son premier `await`** est suivi. Si l'une de ces valeurs change, la donnée est rechargée et la requête précédente est annulée via `signal`.
- **Rechargement** : l'ancien affichage reste en place jusqu'à l'arrivée des nouvelles données. Les données relancées par un même changement basculent ensemble (transition).
- **Écriture locale** : `this.order = autre` remplace la valeur sans lancer de requête (mise à jour optimiste).
- **Statut** : `loading(x)`, `error(x)` et `refresh(x)` dans les templates, `loading(() => this.x)` en TypeScript. Ils observent sans déclencher de chargement.
- `load(fetcher, { eager: true })` charge dès la création.

## Templates

```xml
<div class="card" t-att-class="{ active: selected }">
    <h1>{{ title }}</h1>                                  <!-- texte (échappé) -->
    <a t-att-href="url" title="Ouvrir {{ name }}">…</a>   <!-- attributs dynamiques -->
    <p t-if="lines.length">…</p><p t-else="">Vide</p>
    <tr t-foreach="lines" t-as="line" t-key="line.id">…{{ line_index }}…</tr>
    <t t-set="double" t-value="qty * 2"/>                 <!-- variable locale réactive -->
    <t t-out="markup(html)"/>                             <!-- HTML brut (explicite) -->
    <input t-att-value="name" t-on-input="(ev) => name = ev.target.value"/>
    <button t-on-click.prevent="save">…</button>
    <canvas t-ref="canvas"/>
    <OrderLineRow line="line" onRemove="() => remove(line)"/>
    <t t-call="web.badge" label="'Nouveau'"/>
</div>
```

- Pas de `this.` : `order.total` désigne le membre `order` du composant (`this.order` reste accepté). Les variables de boucle, de `t-set` et de slot sont prioritaires.
- Les attributs d'un composant sont des **expressions** : `label="'texte'"`, `count="n + 1"`, ou `label="Commande {{ id }}"`.
- `t-key` hors d'une boucle recrée l'élément ou le composant quand la valeur change : `<OrderForm t-key="orderId" orderId="orderId"/>` repart d'un état local propre à chaque changement de commande. Sans `t-key`, le composant est conservé et seules ses liaisons se mettent à jour. La nouvelle instance est préparée hors du DOM : l'ancienne reste affichée pendant son chargement.
- `t-on-*` accepte un nom de méthode (`save`), une fonction fléchée (`(ev) => …`) ou une instruction (`count = 0`). Modificateurs disponibles : `.prevent`, `.stop`, `.self`, `.capture`, `.once`, `.passive`, `.delegate`.
- `.delegate` (délégation) : au lieu d'un écouteur par élément, un seul écouteur sur le document pour ce type d'événement. C'est utile pour les très grandes listes. Les gestionnaires délégués s'exécutent après les écouteurs directs, et `.stop` arrête la remontée vers les gestionnaires délégués des ancêtres. Pour les événements qui ne remontent pas (`focus`, `blur`, `mouseenter`…), Trame pose un écouteur sur l'élément, comme sans `.delegate`.
- `value`, `checked` et `selected` sont écrits comme des propriétés. Une saisie en cours équivalente (`1.` pour `1`) n'est pas écrasée.
- Il n'y a pas de `t-model` : on écrit `t-att-value` et `t-on-input` explicitement.

## Composants

```ts
class Card extends Component {
    static template = xml`<div class="card"><t t-slot="header">Titre</t><t t-slot="default"/></div>`;
    static components = { Badge };
    props = props({
        title: t.string(),
        size: t.number().default(1),
        onClose: t.func<() => void>().optional(),
    });
}
```

- **Props** : `props = props({...})` fournit à la fois le type TS de `this.props`, la validation en mode dev (type, props manquantes ou inconnues) et les valeurs par défaut. Validateurs disponibles : `t.string/number/boolean/func/any/instanceOf/array/object/literal/or`, avec `.optional()`, `.default(v)` et `.orNull()`.
- **Lecture seule profonde** : un enfant ne modifie jamais ses props. Il prévient le parent par un callback (`onUpdate`, `onRemove`…). C'est garanti par le type de `this.props` (`DeepReadonly`) et par `trame-check`. À l'exécution, l'enfant reçoit les objets mêmes du parent, en dev comme en prod (même identité) ; seul l'objet `this.props` refuse les écritures.
- **Slots** : `t-set-slot="nom"` (avec `t-slot-scope="s"` pour recevoir des valeurs) côté parent, `t-slot="nom"` côté enfant. Le contenu de `t-slot` sert de contenu par défaut.
- **Composant dynamique** : `<t t-component="expr"/>`.
- **Composants intégrés** : `<Suspense>` (slot `fallback`), `<ErrorBoundary>` (slot `fallback` avec `{ error, reset }`) et `<Portal target="'#id'">`.

## Services

```ts
class Rpc { call(route: string) { … } }

class OrderForm extends Component {
    @inject(Rpc) rpc!: Rpc;                   // fourni par l'application
    @provide editor = new OrderEditor(this);  // fourni à tout le sous-arbre
}

mount(App, el, { provide: [Rpc, new User(…)] });   // une classe est instanciée à la première demande
```

Un descendant, quelle que soit sa profondeur, récupère `editor` avec `@inject(OrderEditor)`, sans que les niveaux intermédiaires aient à le transmettre. On peut injecter une classe parente : on obtient alors l'instance fournie de la sous-classe.

## Extensibilité (modules)

```ts
// Surcharger ou ajouter des membres, avec super. Toutes les instances et sous-classes en profitent.
patch(OrderLine, class extends OrderLine {
    @state accessor ecoTax = 0;
    @computed override get total() { return super.total + this.ecoTax; }
});

// Étendre un template (xpath, ou raccourci élément + position)
extendTemplate(OrderForm, `
    <t>
        <xpath expr="//h1" position="after"><p>Client : {{ order.partner }}</p></xpath>
        <div name="footer" position="inside"><button t-on-click="print">Imprimer</button></div>
    </t>`);

// Nouveau template dérivé, sans modifier l'original
static template = inheritTemplate(OrderForm, `<xpath expr="//h1" position="replace"><h2>…</h2></xpath>`);

// Registres ordonnés et réactifs
registry.category("fields").add("monetary", MonetaryField, { sequence: 10 });
```

Positions disponibles : `inside`, `before`, `after`, `replace` (`$0` réinsère l'élément d'origine) et `attributes` (avec `<attribute name="class" add="x" remove="y"/>`). Le xpath supporté comprend `/a/b`, `//a`, `*`, `[n]`, `[@attr='v']`, `[hasclass('x')]`, `contains()` et `and`.

## Fichiers de templates et précompilation

Les templates peuvent être déclarés dans des fichiers XML, un ou plusieurs par module, plutôt qu'en `xml\`...\`` dans le code :

```xml
<templates>
    <t t-name="sale.OrderForm">                        <!-- nouveau template -->
        <div class="o-order">...</div>
    </t>
    <t t-inherit="web.Card">                            <!-- extension d'un template d'un autre module -->
        <xpath expr="//h1" position="after"><p>...</p></xpath>
    </t>
    <t t-name="sale.SpecialForm" t-inherit="sale.OrderForm">   <!-- nouveau template dérivé -->
        <xpath expr="//h1" position="replace"><h2>...</h2></xpath>
    </t>
</templates>
```

Les composants y font référence par nom : `static template = "sale.OrderForm";`.

**Précompilation côté serveur.** Le serveur passe les fichiers des modules installés, dans l'ordre des dépendances, au compilateur autonome (`dist/trame-compiler.js`). Il reçoit un module JS prêt à servir :

```js
const js = TrameCompiler.compileTemplateFiles([
    { path: "web/static/templates.xml", content: "..." },
    { path: "sale/static/order.xml", content: "..." },
]);
// import { registerCompiled } from "trame";
// registerCompiled("sale.OrderForm", { component: (function ($h) { ... }) });
// ...
```

- Les extensions sont appliquées dans l'ordre des fichiers.
- Les templates appelés par `t-call` sont aussi compilés dans ce mode.
- Une erreur (syntaxe, cible d'extension inconnue, template défini deux fois) lève une exception qui indique le fichier et la ligne.

Côté navigateur, `trame.runtime.js` suffit : il n'y a rien à compiler. En Rust, le compilateur s'exécute par exemple avec le crate `rquickjs`, en environ 0,5 ms par template.

**Sans serveur** (développement, tests) : `registerTemplates(contenuXml, "sale/order.xml")` enregistre un fichier et le compile dans le navigateur (version complète).

## Traductions

```ts
setTranslator((text) => translations[text] ?? text);   // avant le premier montage
```

Les textes statiques des templates et les attributs `title`, `placeholder`, `alt`, `aria-label` et `label` sont traduits. `t-translation="off"` désactive la traduction d'un sous-arbre. Pour traduire depuis le code ou une expression, utilisez `_t("…")`.

## Mode dev

`mount(..., { dev: true })` active :
- la validation des props ;
- les erreurs claires : composant non déclaré, clé `t-foreach` en double, service manquant ;
- **la localisation des erreurs**. Une erreur levée par une liaison, un gestionnaire d'événement ou la création d'un composant indique d'où elle vient dans le template :

  ```
  TypeError: Cannot read properties of null (reading 'toFixed')
      → template "OrderForm", ligne 12 : {{ order.total.toFixed(2) }}
  ```

  La localisation figure dans la pile d'appels, affichée par la console, et dans `error.trameLocation`. Le message de l'erreur n'est pas modifié, pour qu'un `<ErrorBoundary>` affiche un texte propre. Une erreur venant d'une extension de template l'indique aussi (`template "OrderForm" (extension n°1), ligne 2`).

`onError` permet d'intercepter les erreurs non gérées. Sans lui, elles sont affichées dans la console et l'application est démontée.

## Vérification des templates : `trame-check`

```bash
npx trame-check                     # templates des fichiers inclus par tsconfig.json
npx trame-check -p tsconfig.json src/modules
npm run check:templates             # dans ce dépôt : vérifie examples/
```

`trame-check` soumet les expressions des templates à TypeScript, avec les vrais types :

```
src/sale/order_form.ts:49 — template "OrderForm" : Property 'nme' does not exist on type 'OrderForm'. Did you mean 'name'? (TS2551)
src/sale/order_form.ts:51 — template "OrderForm" : Type 'string' is not assignable to type 'OrderLine'. (TS2322)
src/sale/order_form.ts:52 — template "OrderForm" : Property 'onRemove' is missing in type '{ line: OrderLine; }' ... (TS2741)
```

Ce qui est vérifié :
- les membres du composant et les variables de boucle, `t-set` et `t-if` (avec le rétrécissement de type : dans `<p t-if="order">`, `order` n'est plus `null`) ;
- les paramètres d'événements, typés selon la balise : `ev.target.value` est valide sur un `<input>`, pas sur un `<div>` ;
- **les props passées aux composants enfants** : type, props obligatoires manquantes, props inconnues, composant non déclaré dans `static components` ;
- les références (`t-ref`).

Fonctionnement : l'outil copie le projet dans `.trame/check/`, insère dans chaque classe du code de vérification tiré de son template, lance `tsc`, puis ramène les erreurs sur la ligne du template. Rien n'est ajouté au code livré.

Les templates des fichiers XML sont aussi vérifiés. L'outil relie `static template = "sale.OrderForm"` au template du fichier, extensions comprises, et signale les erreurs dans le fichier `.xml` concerné, par exemple `sale/static/order.xml:12` ou le fichier de l'extension fautive.

Non vérifiés :
- les templates contenant `${...}` ;
- les templates appelés par `t-call` (seuls leurs paramètres sont vérifiés) ;
- les extensions passées par `extendTemplate()` / `inheritTemplate()` dans le code ;
- le contenu de la variable `t-slot-scope`, typé `any` ;
- les champs ajoutés par `patch()`, absents du type de la classe.

## Tests : `trame/testing`

```ts
import { afterEach, expect, test } from "vitest";
import { check, cleanup, click, deferred, find, input, render, settle, trigger, waitFor } from "trame/testing";

afterEach(cleanup);

test("formulaire", async () => {
    const order = deferred<Order>();
    const { html, fixture, component } = await render(OrderForm, { props: { orderId: 1 }, provide: [fakeRpc(order)] });
    order.resolve(someOrder);         // simuler la réponse du serveur
    await settle();                   // attendre promesses et mises à jour
    await input(".name", "SO001", {}, fixture);
    await click("button.save", fixture);
    await waitFor(() => expect(find(".status", fixture).textContent).toBe("Enregistré"));
});
```

| Utilitaire | Rôle |
|---|---|
| `render(Composant, options)` | Monte le composant dans un élément attaché au document (mode dev par défaut). Renvoie `{ fixture, component, root, html(), destroy() }`. |
| `cleanup()` | Démonte tout ce qui a été monté (à mettre dans `afterEach`). |
| `settle()` | Attend les promesses en cours et les mises à jour du DOM. |
| `deferred()` | Promesse contrôlée par le test : `resolve` / `reject` au moment voulu. |
| `waitFor(fn, { timeout })` | Réessaie `fn` (par exemple un `expect`) jusqu'à ce qu'il réussisse. |
| `click`, `input`, `check`, `trigger` | Déclenchent des événements, puis attendent les mises à jour. |
| `find(selecteur, racine)` | Trouve un élément, avec une erreur explicite s'il est absent. |
