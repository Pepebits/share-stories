import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // Type-aware linting: needed for no-floating-promises, which is the
        // rule that actually matters in a long-running polling process.
        // tsconfig.test.json is the one that spans both src/ and test/.
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['recommended-type-checked'].rules,

      // TypeScript already resolves identifiers, and no-undef does not know
      // about ambient types like NodeJS.Timeout.
      'no-undef': 'off',

      // An unawaited promise in a poll loop silently swallows failures.
      // node:test's own hooks are the exception: the runner awaits them, so
      // flagging them would bury the real findings under 40 false positives.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',

      // Meta and GramJS both return loosely-typed payloads that are checked
      // at the boundary; blanket-banning `any` here produces noise, not safety.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
];
