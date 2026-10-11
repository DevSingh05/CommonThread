import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const webFiles = ['src/web/**/*.{ts,tsx}', 'test/web/**/*.{ts,tsx}', 'vite.config.ts', 'vitest.web.config.ts', 'playwright*.config.ts'];
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.commonthread/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map(config => ({ ...config, files: webFiles })),
  {
    files: webFiles,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { project: ['./tsconfig.web.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: { '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }] },
  },
  { files: ['src/web/**/*.{ts,tsx}'], plugins: { 'react-hooks': reactHooks }, rules: reactHooks.configs.recommended.rules },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-restricted-syntax': ['error', { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Render untrusted content through SafeMarkdown instead of injecting HTML.' }],
    },
  },
);
