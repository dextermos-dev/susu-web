import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      // Storybook's build output. Minified third-party JavaScript that is
      // generated rather than written, so linting it would only ever report on
      // code nobody here can edit. `.prettierignore` excludes it for the same
      // reason, and `tsconfig.json` never sees it: that config includes `src`
      // only, and a catalogue build is not the app.
      'storybook-static',
      '*.config.js',
      // A design reference kept at the repository root: a page from another
      // project, whose motion this one's landing page is adapted from. It is not
      // part of this app, is not built or shipped, and is not imported by
      // anything — it is here to be read. Linting it would fail the build over
      // style choices in code that never runs, so it is excluded rather than
      // committed, and it should be deleted before this repository is handed to
      // anyone.
      'source.tsx',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Secrets must never be logged.
      //
      // An error rather than a warning, which is what the rules around it are:
      // warnings do not fail `eslint .`, so a `console.log` left in a payments
      // UI would ship, and a debugging line that prints an amount, an address or
      // a session token is exactly the leak this project cares about. The two
      // that stay allowed are the ones a failure needs when there is no UI left
      // to render into. There is no logging module to route through — this is
      // the whole policy.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      /*
       * Money is an integer number of stroops, and must never pass through a
       * float. `src/lib/susu/amounts.ts` is the single boundary where that
       * conversion happens, in `BigInt`, precisely because `Number` cannot
       * represent `0.1` exactly and `0.1 + 0.2 !== 0.3` is not a property a
       * savings protocol can have.
       *
       * The rules below are the two ways that boundary gets bypassed in
       * practice. Neither is stylistic: each one is a silent rounding error in
       * an amount someone is about to sign for.
       */
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'parseFloat produces a float, and money here is an integer number of stroops. Use parseUsdc for what a person typed, or parseBaseUnits for what the API reported (src/lib/susu/amounts.ts).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          property: 'parseFloat',
          message:
            'parseFloat produces a float, and money here is an integer number of stroops. Use parseUsdc for what a person typed, or parseBaseUnits for what the API reported (src/lib/susu/amounts.ts).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // `10^7`, the USDC scale, written as a number. The bigint form
          // (`USDC_SCALE`, or `10n ** 7n`) is the correct one and is untouched
          // by this selector: `BigInt` arithmetic is exact, `Number` is not.
          selector:
            'BinaryExpression[operator=/^[*\\/]$/] > Literal[value=10000000]:not([raw=/n$/])',
          message:
            'The USDC scale as a number is a floating-point conversion: 10^7 stroops is one USDC only while the value stays exact, and it stops being exact above 2^53. Import USDC_SCALE from src/lib/susu/amounts.ts and stay in bigint.',
        },
        {
          selector: "BinaryExpression[operator='**'] > Literal[value=7]:not([raw=/n$/])",
          message:
            'The USDC scale as a number is a floating-point conversion. Import USDC_SCALE from src/lib/susu/amounts.ts and stay in bigint (or raise 10 to the 7th power as a bigint).',
        },
        {
          // Contract reads and API responses are strings and numbers this code
          // did not produce. `dangerouslySetInnerHTML` would hand one of them to
          // the HTML parser, which is how a group name becomes a script tag.
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'Render values as text, not as HTML. Everything on these screens comes from the chain, the API, or another member, and none of it is markup.',
        },
      ],
    },
  },
  {
    /*
     * The network layer is a boundary, not a convenience.
     *
     * `src/lib/stellar/` is where the configured network is derived and
     * re-checked, where Mainnet writes are refused, where raw contract output is
     * decoded defensively, and where the single pipeline every contract call
     * takes lives — build, simulate, sign, submit, then confirm what the ledger
     * actually did. Reaching past it to the SDK from a screen skips all of that:
     * a signer built in a component never sees the guard, and a value decoded in
     * a component is decoded by nothing.
     *
     * So the import is confined to the layer that exists to make it safe. If a
     * screen needs something the SDK offers, the answer is a function in
     * `src/lib/stellar/`, which is also where it can be tested.
     */
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/stellar/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@stellar/stellar-sdk', '@stellar/stellar-sdk/*'],
              message:
                'The Stellar SDK is confined to src/lib/stellar/. Use the typed clients there, which own the network guard, the decoders, and the sign-and-submit pipeline — or add the missing function to that layer.',
            },
          ],
        },
      ],
    },
  },
  {
    // Build scripts run in Node, not the browser, so they need Node globals
    // (`process`, `Buffer`, `console`) rather than the browser set above.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Storybook's own configuration is Node code, not browser code, and it is
    // TypeScript — so it needs the Node globals the app's files must not have,
    // and the parser the `tseslint` configs above already select for `.ts`.
    files: ['.storybook/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // A stories file is a catalogue entry, not a module of the app: it is
    // rendered by Storybook's own entry point and is never imported by
    // `src/main.tsx`. The fast-refresh rule is about editing the running app,
    // and these files export a `meta` object and story objects rather than
    // components, so it would report the same thing on every file here about a
    // state that cannot arise.
    files: ['**/*.stories.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
);
