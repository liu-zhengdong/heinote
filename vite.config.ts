import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function browserSchema(): Plugin {
  const root = dirname(fileURLToPath(import.meta.url));
  const realSchema = resolve(root, "src/platform/schema.ts");
  const browserShim = resolve(root, "src/platform/schema.browser.ts");
  return {
    name: "heinote-browser-schema",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (process.env.VITEST || !importer) return null;
      if (importer === browserShim) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved?.id === realSchema) return browserShim;
      return null;
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [browserSchema(), react()],
  build: {
    rollupOptions: { input: { app: "index.html", select: "components/select.html" } },
  },
});
