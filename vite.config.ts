import { defineConfig, lazyPlugins } from "vite-plus";
import path from "node:path";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", "dist-electron/**", "release/**", ".jin/**"],
  },
  lint: {
    ignorePatterns: ["dist/**", "dist-electron/**", "release/**", ".jin/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [
    react(),
    tailwindcss(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: "electron/main.ts",
        vite: {
          resolve: {
            alias: {
              // The Node build of yaml is CommonJS and calls require("process"),
              // which an ESM Electron main bundle cannot provide. The browser
              // build is pure ESM and uses no Node APIs.
              yaml: path.resolve(__dirname, "node_modules/yaml/browser/index.js"),
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, "electron/preload.ts"),
        vite: {
          build: {
            rollupOptions: {
              output: {
                // Electron preload scripts run as CommonJS. The package is ESM,
                // so the .cjs extension keeps Node from treating it as ESM.
                format: "cjs",
                entryFileNames: "preload.cjs",
              },
            },
          },
        },
        onstart(args) {
          args.reload();
        },
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer:
        process.env.NODE_ENV === "test"
          ? // https://github.com/electron-vite/vite-plugin-electron-renderer/issues/78#issuecomment-2053600808
            undefined
          : {},
    }),
  ]),
});
