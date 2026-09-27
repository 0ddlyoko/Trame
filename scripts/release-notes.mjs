// Affiche la section du CHANGELOG d'une version (notes de la release GitHub).
// Usage : node scripts/release-notes.mjs 0.2.0
import { readFileSync } from "node:fs";

const version = process.argv[2];
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = changelog.indexOf(`## [${version}]`);
if (!version || start === -1) {
    console.error(`CHANGELOG.md : aucune section « ## [${version}] »`);
    process.exit(1);
}
const next = changelog.indexOf("\n## [", start + 1);
const section = changelog.slice(start, next === -1 ? undefined : next).split("\n").slice(1).join("\n").trim();
console.log(section);
