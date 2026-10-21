import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {fileURLToPath} from 'node:url';

// 隔离构建配置：只服务 tests/browser/calibration.spec.ts。
// 产物写入 logs/calibration-dist，绝不覆盖生产 web/frontend/dist。
const root=fileURLToPath(new URL('../../web/frontend',import.meta.url));
const outDir=fileURLToPath(new URL('../../logs/calibration-dist',import.meta.url));

export default defineConfig({
 root,
 plugins:[vue()],
 resolve:{alias:{'@':fileURLToPath(new URL('../../web/frontend/src',import.meta.url))}},
 build:{outDir,emptyOutDir:true},
 preview:{host:'127.0.0.1',port:4190,strictPort:true,proxy:{'/api':'http://127.0.0.1:3080','/ws':{target:'ws://127.0.0.1:3080',ws:true}}},
});
