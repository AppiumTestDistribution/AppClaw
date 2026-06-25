import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import { fileURLToPath } from "url";

export default defineConfig({
  integrations: [react()],
  vite: {
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  },
});
