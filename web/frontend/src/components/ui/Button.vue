<script setup lang="ts">
import {Primitive,type PrimitiveProps} from 'reka-ui';
import {cva} from 'class-variance-authority';
import {cn} from '@/lib/utils';
const props=withDefaults(defineProps<PrimitiveProps & {variant?:'default'|'outline'|'ghost'|'destructive',size?:'default'|'sm'|'icon',class?:string}>(),{as:'button',variant:'default',size:'default'});
const variants=cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50',{variants:{variant:{default:'bg-primary text-white hover:bg-blue-700',outline:'border border-slate-200 bg-white hover:bg-slate-50 text-slate-700',ghost:'hover:bg-slate-100 text-slate-600',destructive:'bg-red-50 text-red-700 hover:bg-red-100'},size:{default:'h-12 px-4',sm:'h-11 px-3',icon:'h-11 w-11'}},defaultVariants:{variant:'default',size:'default'}});
</script>
<template><Primitive :as="as" :as-child="asChild" :class="cn(variants({variant,size}),props.class)"><slot /></Primitive></template>
