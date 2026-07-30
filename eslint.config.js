/**
 * Minimal, deliberately unopinionated ESLint config.
 *
 * The repo had no linter at all, so the priority is catching real defects —
 * an undeclared variable, an unused require, an unreachable statement, a
 * promise nobody awaits — without a style argument that would produce a
 * thousand findings on day one and get switched off. Formatting rules are
 * intentionally absent.
 *
 * Two of the bugs this program actually shipped were exactly what
 * no-undef catches: a `respond` that was never required, and a `fields`
 * that was never bound. Both made routes HANG rather than fail loudly.
 */
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**', 'mobile/**', 'logs/**', 'deploy/**',
      // Browser bundles and marketing pages; linting them is Phase 9's
      // dashboard-decomposition work, not this.
      'public/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // The two that would have caught real, shipped bugs.
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],

      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'require-atomic-updates': 'off',

      // An empty catch is how "best effort" is written throughout this
      // codebase; the comment above each one is the documentation.
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Tests legitimately build throwaway values and stub unused params.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
];
