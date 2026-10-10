import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/{smoke,unit,integration}/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
