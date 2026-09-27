import { transform } from "esbuild";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Vite 8 compile le TypeScript avec oxc, qui ne convertit pas (encore) les décorateurs standard.
 * On confie donc les fichiers .ts à esbuild, qui les convertit.
 */
function standardDecorators(): Plugin {
    return {
        name: "trame:standard-decorators",
        enforce: "pre",
        async transform(code, id) {
            if (!/\.ts$/.test(id.split("?")[0]) || id.includes("node_modules")) {
                return null;
            }
            const result = await transform(code, {
                loader: "ts",
                target: "es2022",
                sourcemap: true,
                sourcefile: id,
                tsconfigRaw: { compilerOptions: { useDefineForClassFields: true, verbatimModuleSyntax: true } },
            });
            return { code: result.code, map: result.map };
        },
    };
}

export default defineConfig({
    plugins: [standardDecorators()],
    resolve: {
        alias: {
            trame: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        },
    },
    test: {
        environment: "jsdom",
        // Un environnement jsdom par worker (isolation par fichier conservée) au lieu d'un par fichier.
        pool: "vmThreads",
        include: ["tests/**/*.test.ts"],
    },
});
