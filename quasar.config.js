// Configuration for your app
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-file

import { defineConfig } from "#q-app/wrappers";
import { prepareElectronResources } from "./scripts/prepare-electron-resources.mjs";
import {
  buildAppUpdateFeedUrl,
} from "./src-electron/updater/update-channel.js";
import { resolveAppEdition } from "./src-electron/updater/edition.js";
import packageJson from "./package.json" with { type: "json" };

const DEV_WATCH_IGNORED = [
  "**/IOPaint",
  "**/IOPaint/**",
  "**/server",
  "**/server/**",
  "**/models",
  "**/models/**",
];
const electronDownloadMirror =
  process.env.MOONSHINE_ELECTRON_MIRROR || process.env.ELECTRON_MIRROR || "";
const electronDownloadCacheRoot =
  process.env.MOONSHINE_ELECTRON_CACHE || ".electron-cache";
const electronZipDir = process.env.MOONSHINE_ELECTRON_ZIP_DIR || "";
const appEdition = resolveAppEdition(packageJson.version);
const updateFeedUrl = buildAppUpdateFeedUrl(appEdition.channel);
const electronPublishConfig = [{ provider: "generic", url: updateFeedUrl }];
const electronDownloadOptions = {
  cacheRoot: electronDownloadCacheRoot,
  ...(electronDownloadMirror
    ? {
        mirrorOptions: {
          mirror: electronDownloadMirror,
        },
      }
    : {}),
};

const includeLegacyPackagedComponents = ["1", "true", "yes"].includes(
  String(process.env.MOONSHINE_PACKAGE_LEGACY_RUNTIME || "")
    .trim()
    .toLowerCase(),
);
const packageRuntimeFlavor = String(process.env.MOONSHINE_RUNTIME_FLAVOR || "cu130")
  .trim()
  .toLowerCase();
const includePackagedSam3 = ["cu126", "cu130"].includes(packageRuntimeFlavor);

export default defineConfig((ctx) => {
  if (ctx.mode.electron && ctx.prod) {
    prepareElectronResources({
      // Normal Builder and Packager builds are app-only. Runtime/models are
      // prepared only for an explicitly requested legacy compatibility build.
      includeBundledComponents: includeLegacyPackagedComponents,
    });
  }

  return {
    // https://v2.quasar.dev/quasar-cli-vite/prefetch-feature
    // preFetch: true,

    // app boot file (/src/boot)
    // --> boot files are part of "main.js"
    // https://v2.quasar.dev/quasar-cli-vite/boot-files
    boot: ["axios"],

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#css
    css: ["app.scss"],

    // https://github.com/quasarframework/quasar/tree/dev/extras
    extras: [
      // 'ionicons-v4',
      // 'mdi-v7',
      // 'fontawesome-v6',
      // 'eva-icons',
      // 'themify',
      // 'line-awesome',
      // 'roboto-font-latin-ext', // this or either 'roboto-font', NEVER both!

      "roboto-font", // optional, you are not bound to it
      "material-icons", // optional, you are not bound to it
    ],

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#build
    build: {
      target: {
        browser: ["es2022", "firefox115", "chrome115", "safari14"],
        node: "node20",
      },

      vueRouterMode: "hash", // available values: 'hash', 'history'
      // vueRouterBase,
      // vueDevtools,
      // vueOptionsAPI: false,

      // rebuildCache: true, // rebuilds Vite/linter/etc cache on startup

      // publicPath: '/',
      // analyze: true,
      // env: {},
      // rawDefine: {}
      // ignorePublicFolder: true,
      // minify: false,
      // polyfillModulePreload: true,
      // distDir
      // viteVuePluginOptions: {},
      extendViteConf(viteConf) {
        viteConf.build = {
          ...(viteConf.build || {}),
          chunkSizeWarningLimit: 600,
        };

        if (!ctx.dev) {
          return;
        }

        const currentIgnored = viteConf.server?.watch?.ignored;
        const ignored = Array.isArray(currentIgnored)
          ? [...currentIgnored, ...DEV_WATCH_IGNORED]
          : currentIgnored
            ? [currentIgnored, ...DEV_WATCH_IGNORED]
            : [...DEV_WATCH_IGNORED];

        viteConf.server = {
          ...(viteConf.server || {}),
          watch: {
            ...(viteConf.server?.watch || {}),
            ignored,
          },
        };
      },
      vitePlugins: ctx.dev
        ? [
            [
              "vite-plugin-checker",
              {
                eslint: {
                  lintCommand:
                    'eslint -c ./eslint.config.js "./src*/**/*.{js,mjs,cjs,vue}"',
                  useFlatConfig: true,
                },
              },
              { server: false },
            ],
          ]
        : [],
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#devserver
    devServer: {
      // https: true,
      open: process.env.MOONSHINE_E2E !== "1", // opens browser window automatically
    },

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#framework
    framework: {
      config: {
        brand: {
          primary: "#7758c4",
          secondary: "#2679a6",
          accent: "#9C27B0",

          dark: "#383636",
          "dark-page": "#121212",

          positive: "#21BA45",
          negative: "#C10015",
          info: "#abd1d9",
          warning: "#f0df73",
        },
      },

      // iconSet: 'material-icons', // Quasar icon set
      // lang: 'en-US', // Quasar language pack

      // For special cases outside of where the auto-import strategy can have an impact
      // (like functional components as one of the examples),
      // you can manually specify Quasar components/directives to be available everywhere:
      //
      // components: [],
      // directives: [],

      // Quasar plugins
      plugins: ["Dialog", "Notify", "Loading"],
    },

    // animations: 'all', // --- includes all animations
    // https://v2.quasar.dev/options/animations
    animations: [],

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-file#sourcefiles
    sourceFiles: {
      //   rootComponent: 'src/App.vue',
      //   router: 'src/router/index',
      //   store: 'src/store/index',
      //   pwaRegisterServiceWorker: 'src-pwa/register-service-worker',
      //   pwaServiceWorker: 'src-pwa/custom-service-worker',
      //   pwaManifestFile: 'src-pwa/manifest.json',
      electronMain: "src-electron/electron-main",
      electronPreload: "src-electron/electron-preload",
      //   bexManifestFile: 'src-bex/manifest.json
    },

    // https://v2.quasar.dev/quasar-cli-vite/developing-ssr/configuring-ssr
    ssr: {
      prodPort: 3000, // The default port that the production server should use
      // (gets superseded if process.env.PORT is specified at runtime)

      middlewares: [
        "render", // keep this as last one
      ],

      // extendPackageJson (json) {},
      // extendSSRWebserverConf (esbuildConf) {},

      // manualStoreSerialization: true,
      // manualStoreSsrContextInjection: true,
      // manualStoreHydration: true,
      // manualPostHydrationTrigger: true,

      pwa: false,
      // pwaOfflineHtmlFilename: 'offline.html', // do NOT use index.html as name!

      // pwaExtendGenerateSWOptions (cfg) {},
      // pwaExtendInjectManifestOptions (cfg) {}
    },

    // https://v2.quasar.dev/quasar-cli-vite/developing-pwa/configuring-pwa
    pwa: {
      workboxMode: "GenerateSW", // 'GenerateSW' or 'InjectManifest'
      // swFilename: 'sw.js',
      // manifestFilename: 'manifest.json',
      // extendManifestJson (json) {},
      // useCredentialsForManifestTag: true,
      // injectPwaMetaTags: false,
      // extendPWACustomSWConf (esbuildConf) {},
      // extendGenerateSWOptions (cfg) {},
      // extendInjectManifestOptions (cfg) {}
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-cordova-apps/configuring-cordova
    cordova: {
      // noIosLegacyBuildFlag: true, // uncomment only if you know what you are doing
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-capacitor-apps/configuring-capacitor
    capacitor: {
      hideSplashscreen: true,
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/configuring-electron
    electron: {
      // extendElectronMainConf (esbuildConf) {
      //   esbuildConf.outfile = 'electron-main.js'
      // },
      // extendElectronPreloadConf (esbuildConf) {},

      // extendPackageJson (json) {
      //   json.main = './electron-main.js'
      // },

      // Electron preload scripts (if any) from /src-electron, WITHOUT file extension
      preloadScripts: ["electron-preload"],

      // specify the debugging port to use for the Electron app when running in development mode
      inspectPort: 5858,

      bundler: "packager", // 'packager' or 'builder'

      packager: {
        // https://github.com/electron-userland/electron-packager/blob/master/docs/api.md#options
        // OS X / Mac App Store
        // appBundleId: '',
        // appCategoryType: '',
        // osxSign: '',
        // protocol: 'myapp://path',
        // Windows only
        // win32metadata: { ... }
        name: appEdition.productName,
        executableName: appEdition.executableName,
        icon: "src-electron/icons/icon.ico",
        dir: ".",
        out: "dist/electron/packaged",
        overwrite: true,
        asar: true,
        ...(electronZipDir ? { electronZipDir } : { download: electronDownloadOptions }),

        // Application metadata comes from package.json to keep installer and
        // runtime update versions aligned.
        appCopyright: "Copyright © 2023 CuiMuxuan",
        appCategoryType: "public.app-category.utilities",

        // Windows-specific metadata
        win32metadata: {
          CompanyName: "CuiMuxuan",
          FileDescription: "Moonshine 图像处理客户端",
          OriginalFilename: `${appEdition.executableName}.exe`,
          ProductName: appEdition.productName,
          InternalName: appEdition.executableName,
        },

        // Ignore source-only files from the packaged app root
        ignore: [
          "/\\.git($|/)",
          "/\\.quasar($|/)",
          "/node_modules($|/)",
          "/src($|/)",
          "/dist/spa($|/)",
          "/build-resources($|/)",
          "/IOPaint($|/)",
          "/server($|/)",
          "/models($|/)",
          "/scripts($|/)",
        ],
        extraResource: [
          "build-resources/backend",
          "build-resources/ffmpeg",
          "build-resources/integrity",
          "build-resources/mcp",
          ...(includePackagedSam3 ? ["build-resources/sam3"] : []),
          ...(includeLegacyPackagedComponents
            ? ["build-resources/runtime", "build-resources/models"]
            : []),
        ],
      },

      builder: {
        // https://www.electron.build/configuration/configuration
        // Reuse the Electron distribution installed by npm. This keeps Builder
        // aligned with the lockfile and avoids a second GitHub ZIP download.
        electronDist: "node_modules/electron/dist",

        // Application metadata
        appId: appEdition.appId,
        productName: appEdition.productName,
        // electron-builder derives electron-updater's cache directory from the
        // packaged package name. Keep it unique so test and official editions
        // cannot share downloaded installers under %LOCALAPPDATA%.
        extraMetadata: {
          name: appEdition.packageName,
        },
        afterPack: "scripts/after-pack-windows.mjs",

        // Windows packaging
        win: {
          target: ["nsis"],
          icon: "src-electron/icons/icon.ico",
          // The first R2 release remains unsigned. A local afterPack hook uses
          // the npm-bundled rcedit binary, avoiding electron-builder's GitHub
          // winCodeSign download while still embedding the application icon.
        },

        // Installer options
        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true,
          shortcutName: appEdition.productName,
          include: "build-resources/installer-offline.nsh",
        },

        // App-only NSIS resources. The Python/Torch environment is created in
        // userData on first launch; the small backend, FFmpeg executable and
        // integrity receipt are kept in the installer so setup has no second
        // public runtime download dependency. Full offline ZIPs are assembled
        // separately from explicit payload roots.
        extraResources: [
          {
            from: "build-resources/mcp",
            to: "mcp",
          },
          {
            from: "build-resources/backend",
            to: "backend",
          },
          ...(includePackagedSam3
            ? [{
                from: "build-resources/sam3",
                to: "sam3",
              }]
            : []),
          {
            from: "build-resources/ffmpeg",
            to: "ffmpeg",
          },
          {
            from: "build-resources/integrity",
            to: "integrity",
          },
        ],

        // Installer artifact naming
        artifactName: appEdition.artifactName,
        // Auto-update configuration
        publish: electronPublishConfig,
      },
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-browser-extensions/configuring-bex
    bex: {
      // extendBexScriptsConf (esbuildConf) {},
      // extendBexManifestJson (json) {},

      /**
       * The list of extra scripts (js/ts) not in your bex manifest that you want to
       * compile and use in your browser extension. Maybe dynamic use them?
       *
       * Each entry in the list should be a relative filename to /src-bex/
       *
       * @example [ 'my-script.ts', 'sub-folder/my-other-script.js' ]
       */
      extraScripts: [],
    },
  };
});
