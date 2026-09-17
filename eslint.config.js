import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { react },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      // `try { … } catch {}` is a deliberate idiom here — a best-effort read
      // whose failure is the answer, not an error. Flagging all thirteen of
      // them taught everybody that `npm run lint` is red and means nothing,
      // which is how a missing import reached production under a green build.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A component used in JSX and never imported is invisible to `no-undef`:
      // it only sees identifiers, and <Select /> is a JSX tag until the plugin
      // that understands JSX says otherwise. So the file builds, lints clean,
      // and throws ReferenceError the moment React renders it — and with no
      // error boundary above the routes, that throw unmounts the whole app.
      // That is exactly how GTM > Outbound became a blank white page: one
      // missing import line, green on every check we had.
      'react/jsx-no-undef': 'error',
    },
  },
  {
    // The server half of this repo is Node, not a browser: `process`, `console`
    // and friends are the runtime, not undefined globals. Without this, 210 of
    // the 242 errors `npm run lint` reported were every server file saying
    // `process.env` — noise that hid the real ones and taught everybody to
    // ignore the command.
    files: ['server/**/*.js', 'api/**/*.js', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
])
