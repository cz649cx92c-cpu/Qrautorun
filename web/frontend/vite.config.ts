import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[vue()],resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}},server:{host:'0.0.0.0',port:5173,proxy:{'/api':'http://127.0.0.1:3080','/ws':{target:'ws://127.0.0.1:3080',ws:true}}},build:{outDir:'dist'}});
