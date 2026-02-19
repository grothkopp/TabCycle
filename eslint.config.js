import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  // ── Allow underscore-prefixed variables to suppress no-unused-vars ────────
  {
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },

  // ── Shared source config (src/**) ──────────────────────────────────────────
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
      },
    },
  },

  // ── Service worker (no DOM) ────────────────────────────────────────────────
  {
    files: ['src/background/**/*.js', 'src/shared/**/*.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },

  // ── Options page (browser DOM) ─────────────────────────────────────────────
  {
    files: ['src/options/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // ── Tests (Node + Jest) ────────────────────────────────────────────────────
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
        chrome: 'readonly',
      },
    },
  },

  // ── E2E tests also use browser globals inside page.evaluate() ──────────────
  {
    files: ['tests/e2e/**/*.js', 'tests/e2e-chrome/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // ── Ignore build output ────────────────────────────────────────────────────
  {
    ignores: ['dist/', 'node_modules/'],
  },
];
