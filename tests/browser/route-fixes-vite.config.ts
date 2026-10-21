import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../web/frontend',import.meta.url));
const outDir=fileURLToPath(new URL('../../logs/route-fixes-dist',import.meta.url));

export default defineConfig({
 root,
 plugins:[vue()],
 resolve:{alias:{'@':fileURLToPath(new URL('../../web/frontend/src',import.meta.url))}},
 build:{outDir,emptyOutDir:true},
 preview:{host:'127.0.0.1',port:4192,strictPort:true,proxy:{'/api':'http://127.0.0.1:3080','/ws':{target:'ws://127.0.0.1:3080',ws:true}}},
});
