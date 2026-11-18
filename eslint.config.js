// 書き方の検査（npm run lint）。見落としやすい間違いだけを拾う、ゆるめの設定。
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.wrangler/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Cloudflare Workers で使えるもの（fetch・crypto・Response など）
      globals: { ...globals.serviceworker, ...globals.es2024 },
    },
  },
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
  },
  {
    rules: {
      // 使っていない引数は _ で始めれば許す（画面の関数は (ix, args, ctx) の形をそろえているため）
      // 日本語の文では全角の空白（　）を区切りに使っているので、文字列とコメントの中は許す
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true, skipRegExps: true }],
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
