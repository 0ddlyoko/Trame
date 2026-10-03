# Changelog

Format : une section par version. Les changements incompatibles sont listés en premier.

## [0.2.2] - 2026-10-03

### Corrections

- Erreur au premier montage interceptée par une `<ErrorBoundary>` : `mount()` ne reste plus bloqué quand le fallback détruit une ressource encore attendue (en chargement, ou dont l'arrivée venait de rendre le contenu fautif). Auparavant la page restait vide, sans rejet de `mount()` ni appel à `onError`.

## [0.2.1] - 2026-10-02

### Corrections

- Changement de vue (`t-if`, `t-key`, `t-component`) : le contenu sortant, encore affiché pendant le chargement du nouveau, est gelé. Ses liaisons, `@computed`, `@effect` et `@resource` ne se relancent plus avec l'état destiné au nouveau contenu ; il reprend vie si le changement est annulé. Une ligne retirée d'un `t-foreach` ne recharge plus ses données juste avant son retrait.

## [0.2.0] - 2026-09-28

### Changements incompatibles

- **Erreurs d'actions** : une erreur levée par un gestionnaire d'événement (`t-on-*`), y compris une promesse rejetée, ne va plus à l'`<ErrorBoundary>` la plus proche. Elle va au nouveau composant `<ErrorHandler onError="...">` ; sinon à `mount(..., { onError })` ; sinon elle est affichée dans la console et **l'application reste montée**. Les erreurs de rendu (liaisons, `@effect`, construction, chargement) ne changent pas.
- **Props en mode dev** : le Proxy de lecture seule est supprimé. L'enfant reçoit les objets mêmes du parent, en dev comme en prod ; la lecture seule profonde reste vérifiée par TypeScript (`DeepReadonly`) et `trame-check`. `this.props` refuse toujours les écritures.
- **Services** : fournir deux fois le même service au même niveau lève une erreur. Injecter une classe parente dont héritent plusieurs services d'un même niveau lève une erreur (ambiguïté) au lieu de renvoyer le dernier fourni. Une dépendance circulaire entre services lève une erreur qui décrit le cycle.
- **Macros `loading` / `error` / `refresh`** : si le composant a une méthode du même nom, `refresh(x)` appelle la méthode (un champ non fonction ne gêne pas la macro).
- **Expressions de template** : analysées par un vrai parseur. Une expression invalide est refusée à la compilation avec sa position ; `this` n'est plus réécrit dans une fonction non fléchée ; `class`, `super`, `import` et `yield` ne sont pas pris en charge.
- **Schéma des props** : lu une fois par classe de composant (celui de la première instance) ; il ne doit pas dépendre de l'instance.
- **`testing.js`** importe `trame` par son nom (et non plus le fichier `./trame.js`) : l'import map de l'application doit associer `trame` au même fichier que l'application, ce qui garantit une seule instance.

### Nouveautés

- `<ErrorHandler onError="...">` : reçoit les erreurs des actions de son contenu, sans le remplacer.
- `load(source, fetcher)` : dépendances explicites d'une ressource. Seule la source est suivie ; le fetcher reçoit sa valeur et n'est pas suivi (plus de dépendance perdue après un `await`).
- `@computed({ eager: true })` : valeur préchargée (données lues chargées d'avance, même dans un `t-if` fermé), sans retarder l'affichage.
- Expressions : variables, fonctions, boucles, `try`/`catch`, `switch`... dans le corps des fonctions ; commentaires ; identifiants accentués.
- `t-foreach` sans `t-key` accepte les valeurs en double ; `t-foreach` sur une chaîne.
- `Trame.VERSION` et un en-tête de version dans chaque fichier distribué ; `dist/trame.d.ts` : toutes les déclarations en un seul fichier.

### Corrections

- Une promesse rejetée par un gestionnaire écrit `save(x)`, `(ev) => save(ev)` ou en instruction n'était pas remontée (seule la forme `save` l'était).
- `() => { const x = 1; ... }` et les paramètres de `function (...)` produisaient du code invalide.
- Un template dérivé (`inheritTemplate`) déjà compilé ne voyait pas une extension ajoutée à sa base.
- Un modèle créé dans un gestionnaire d'événement ou un `@effect` n'était rattaché à aucun scope (requêtes jamais annulées, effets jamais arrêtés) ; un `@effect` d'un objet créé après le montage s'exécutait avant l'initialisation de ses champs.
- Une erreur de construction dans un contenu apparu après le montage (branche de `t-if`, nouvelle ligne, `t-key`) était remplacée par une erreur secondaire dans l'`<ErrorBoundary>`.
- Une prop inconnue nommée `toString`, `constructor`... n'était pas signalée.
- `.delegate` ne fonctionnait pas dans un Shadow DOM.
- `Map`, `Set` et champs `#privés` passés en props étaient cassés en mode dev.
- Les bundles minifiés contenaient des caractères non ASCII (plantage au chargement sans `charset=utf-8`).

### Performances

Mesures dans Chrome, 1 000 lignes (voir `docs/design.md`, section Performances) :

- Mémoire : −30 % (lignes à 5 champs) et −37 % (enregistrements à 30 champs dont 5 affichés). Trame est maintenant plus léger qu'OWL 3.
- Création −18 %, destruction −16 % ; aucune allocation pendant une mise à jour qui relit les mêmes dépendances.
- Détail : schéma des props partagé par classe, signaux `@state` créés à la première lecture suivie, graphe réactif en liste chaînée, scopes et effets allégés, lignes ajoutées insérées sans nœud provisoire, `patch()` sans coût par appel.

### Outillage

- CI GitHub (Node 22 et 24) et release automatique à chaque tag `v*` ; test de fumée dans Chrome des fichiers distribués (import map et script classique).
- Banc de mesure dans Chrome contre OWL 3 (`npm run bench:chrome`, `npm run bench:memory`).
- Tests 5× plus rapides.
- Développement : Node 22 ou 24 (la bibliothèque distribuée cible toujours les navigateurs ES2019).

## [0.1.0]

Première version : réactivité à base de signaux et décorateurs, templates XML compilés et extensibles par xpath, asynchrone intégré, `patch()`, registres, services, `trame-check`, `trame/testing`.
