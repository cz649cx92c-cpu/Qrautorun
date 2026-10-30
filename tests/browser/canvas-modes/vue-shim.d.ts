// The canvas interaction fixture mounts a real .vue SFC directly. tsc only needs a
// module shape for the import; the actual component types come from vue-tsc.
declare module '*.vue' {
  import type {DefineComponent} from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
