import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import {readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import * as ethers from 'ethers';
import {createNativeClient} from './src/native-frame/native-client.mjs';

// __dirname is not defined in ESM modules. Reconstruct it from import.meta.url
// so `resolve(__dirname, "popup.html")` works on both POSIX and Windows. The
// previous vite.config.ts got away with a bare `__dirname` because Vite's TS
// pipeline shimmed it; the plain .js version needs this line.
const __dirname = dirname(fileURLToPath(import.meta.url));
// The native frame profile pins the network, the leanSPHINCS account factory, its implementation and verifier.
// A build requires an active one; the inactive default serves tests and the dev server only.
const nativeProfilePath = resolve(__dirname, process.env.NICETRY_NATIVE_PROFILE || 'src/native-frame/native-deployment.json');
const nativeProfile = JSON.parse(readFileSync(nativeProfilePath,'utf8'));
if (typeof nativeProfile.active !== 'boolean') throw Error('The native profile requires an explicit boolean active flag.');
if (nativeProfile.active) {
  // Build-time validation checks pin completeness. Runtime checks also compare
  // the actual chain, genesis, contract bytecode and RPC capabilities.
  createNativeClient(ethers,{config:nativeProfile,rpc:async()=>{},receiptOutcome:()=>{}});
}
export const extensionDescription = 'Experimental Daisugi testnet wallet with SPHINCS signing: native frames.';
// Every import of the default profile file resolves to the selected profile, whatever form its specifier takes
// (relative to the importer, '@/' alias or absolute).
const defaultProfiles = new Map([
  [resolve(__dirname, 'src/native-frame/native-deployment.json'), nativeProfilePath],
]);
const deploymentProfile = {
  name:'native-deployment-profile',enforce:'pre',
  resolveId(source, importer) {
    const target = source.startsWith('@/') ? resolve(__dirname, 'src', source.slice(2))
      : source.startsWith('.') && importer ? resolve(dirname(importer.split('?')[0]), source)
      : source.startsWith('/') ? resolve(source) : null;
    return defaultProfiles.get(target);
  }
};
const publicRpc = process.env.NICETRY_RPC_URL;
const publicExplorer = process.env.NICETRY_EXPLORER_URL;
if (publicExplorer) {
  const url = new URL(publicExplorer);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /^(localhost|127\.|\[::1\])/.test(url.hostname)) {
    throw new Error('NICETRY_EXPLORER_URL must be a public HTTPS explorer URL without credentials, query or fragment.');
  }
}
let publicOrigin, outputDirectory, buildFailed = false;
if (publicRpc) {
  const url = new URL(publicRpc);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/rpc' || /^(localhost|127\.|\[::1\])/.test(url.hostname)) {
    throw new Error('NICETRY_RPC_URL must be an explicit HTTPS /rpc endpoint without credentials, query or fragment.');
  }
  publicOrigin = url.origin;
}
const publicRpcManifest = {
  name:'native-public-rpc-profile',
  buildEnd(error) { buildFailed = Boolean(error); },
  configResolved(config) {
    if (config.command === 'build' && (!publicRpc || !publicExplorer)) throw new Error('Set NICETRY_RPC_URL and NICETRY_EXPLORER_URL to the verified HTTPS environment before building.');
    if (config.command === 'build' && !nativeProfile.active) throw new Error('Set NICETRY_NATIVE_PROFILE to an active native frame profile before building.');
    outputDirectory=resolve(config.root,config.build.outDir);
    if (publicRpc && outputDirectory === resolve(__dirname,'nicetry-daisugi')) throw new Error('Use a separate --outDir for an HTTPS preview build.');
  },
  async closeBundle() {
    if (!publicRpc || buildFailed) return;
    const file=resolve(outputDirectory,'manifest.json');
    const manifest=JSON.parse(await readFile(file,'utf8'));
    manifest.name='NiceTry Daisugi — native frames preview';
    manifest.description=extensionDescription;
    manifest.host_permissions=[...new Set([...manifest.host_permissions.filter(origin=>origin.startsWith('https:') && !origin.includes('daisugi.fyi')),publicOrigin+'/*'])];
    await writeFile(file,JSON.stringify(manifest,null,2)+'\n');
  }
};

export default defineConfig({
  base: "./",

  plugins: [deploymentProfile, preact(), tailwindcss(), publicRpcManifest],

  // The leanSPHINCS signer runs in an ES module worker
  // (new Worker(url, { type: "module" })); emit it as an ES module.
  worker: {
    format: "es",
  },

  build: {
    outDir: "nicetry-daisugi",
    emptyOutDir: true,
    target: "esnext",
    minify: "terser",
    cssCodeSplit: true,

    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        onboarding: resolve(__dirname, "onboarding.html"),
        background: resolve(__dirname, "src/background/index.js"),
        "content-script": resolve(__dirname, "src/content-script/index.js"),
        inpage: resolve(__dirname, "src/inpage/index.js"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (info) => {
          // Keep HTML-adjacent CSS predictable; other assets keep their name.
          if (info.name && info.name.endsWith(".css")) return "[name].[ext]";
          return "[name].[ext]";
        },
      },
    },

    assetsInlineLimit: 0,
  },

  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // Any dep that imports "react" / "react-dom" (e.g. future third-party
      // components) silently lands on preact/compat. Our own code imports
      // from "preact" directly and never touches these aliases.
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
      // Map lucide-react to the native preact build. Keeps user code
      // portable: `import { Wallet } from "lucide-react"` just works.
      "lucide-react": "lucide-preact",
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    ...(publicRpc ? {__DAISUGI_RPC_URL__:JSON.stringify(publicRpc)} : {}),
    ...(publicExplorer ? {__DAISUGI_EXPLORER_URL__:JSON.stringify(publicExplorer.replace(/\/$/,''))} : {}),
  },
});
