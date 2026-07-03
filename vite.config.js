import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  root: "web-src",
  build: {
    outDir: "../assets/dist",
    emptyOutDir: true,
  },
});
