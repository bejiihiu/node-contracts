import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // no tests yet - keep the early runs green
        passWithNoTests: true,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['dist/**', 'examples/**', 'tests/**', 'benchmarks/**', '**/*.d.ts'],
            reporter: ['text', 'lcov'],
            thresholds: {
                lines: 80,
                functions: 80,
                statements: 80,
                branches: 80,
            },
        },
    },
});
