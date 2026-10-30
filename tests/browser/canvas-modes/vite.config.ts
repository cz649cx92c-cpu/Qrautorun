import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {fileURLToPath} from 'node:url';

// 自包含夹具：只挂载 MapCanvas.vue，不加载 App.vue、不连后端。
// root 设为仓库根，页面入口是 /tests/browser/canvas-modes/index.html，
// 这样 MapCanvas 与 ui/Button.vue 的 @/ 别名和相对 import 都能按仓库原样解析。
const repoRoot=fileURLToPath(new URL('../../../',import.meta.url));

export default defineConfig({
 root:repoRoot,
 plugins:[vue()],
 resolve:{alias:{'@':fileURLToPath(new URL('../../../web/frontend/src',import.meta.url))}},
 server:{fs:{allow:[repoRoot]},host:'127.0.0.1'},
});
