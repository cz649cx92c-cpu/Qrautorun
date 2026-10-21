import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {fileURLToPath} from 'node:url';
// Test/preview harness only: builds the frontend into a throw-away directory and serves it
// through a proxy to the real backend, so the production web/frontend/dist is never touched.
const root=fileURLToPath(new URL('../../web/frontend/',import.meta.url));
const out=process.env.PREVIEW_OUT||fileURLToPath(new URL('../../logs/preview-build/',import.meta.url));
const port=Number(process.env.PREVIEW_PORT||4191);
const proxy={'/api':'http://127.0.0.1:3080','/ws':{target:'ws://127.0.0.1:3080',ws:true}};
export default defineConfig({root,plugins:[vue()],resolve:{alias:{'@':root+'src'}},
 build:{outDir:out,emptyOutDir:true},
 server:{host:'127.0.0.1',port:port+100,proxy},
 preview:{host:'127.0.0.1',port,strictPort:true,proxy}});
