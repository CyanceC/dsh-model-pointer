import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const { name } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }

const CLIENT_SEEDS = ['react', 'react/jsx-runtime', /^@deepseek-ai\//]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [/^@deepseek-ai\//],
      onlyBundle: false,
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    outExtensions: () => ({ js: '.cjs' }),
    dts: false,
    clean: false,
    sourcemap: true,
    minify: true,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    deps: {
      neverBundle: CLIENT_SEEDS,
      onlyBundle: false,
    },
    banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
    footer: { js: 'return module.exports;}});' },
  },
])
