import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

/** Attributes whose value a visitor reads or hears. */
const TEXT_ATTRIBUTES = new Set(['alt', 'aria-label', 'label', 'placeholder', 'title']);
const hasLetter = (text) => /\p{L}/u.test(text);

/**
 * Text a visitor reads belongs in src/i18n/messages, where every language has it.
 * Reported: JSX text with a letter in it, and a string with one that goes onto the page,
 * as a child of an element or as a text attribute, also through `?:`, `&&` and `||`.
 */
const noLiteralUiText = {
  meta: {
    type: 'problem',
    messages: {
      literal: 'Text shown to a visitor goes in src/i18n/messages, so that every language has it.',
    },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'literal' });
    const shown = (node) => {
      let holder = node.parent;
      while (holder.type === 'ConditionalExpression' || holder.type === 'LogicalExpression')
        holder = holder.parent;
      if (holder.type === 'JSXExpressionContainer') holder = holder.parent;
      if (holder.type === 'JSXAttribute') return TEXT_ATTRIBUTES.has(holder.name.name);
      return holder.type === 'JSXElement' || holder.type === 'JSXFragment';
    };
    return {
      JSXText(node) {
        if (hasLetter(node.value)) report(node);
      },
      Literal(node) {
        if (typeof node.value === 'string' && hasLetter(node.value) && shown(node)) report(node);
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => hasLetter(quasi.value.cooked ?? '')) && shown(node))
          report(node);
      },
    };
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/__tests__/**', 'src/test/**'],
    plugins: {
      local: { rules: { 'no-literal-ui-text': noLiteralUiText } },
    },
    rules: {
      'local/no-literal-ui-text': 'error',
    },
  },
  {
    // The encryption and the API client know nothing of the interface language: they
    // report what failed as a code or a status, and the pages put it into words.
    files: ['src/crypto/**', 'src/api/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/i18n', '**/i18n/**'],
              message: 'Report a code or a status here; the pages turn it into text.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.js'],
  },
);
