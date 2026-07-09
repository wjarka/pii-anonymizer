import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  testMatch: ['electron-startup.spec.js'],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
