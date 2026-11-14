import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/adapters/index.ts', 'src/decorators/index.ts'],
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node18',
    dts: true,
    sourcemap: true,
    minify: false,
    treeshake: true,
    clean: true,
    tsconfig: 'tsconfig.build.json',
});
