// Not a proposal to adopt eslint. The two rules cover bugs this webview has shipped, and the
// config costs 194 packages where typescript costs 1. It exists so the comparison in REPORT.md
// is reproducible.
import globals from "globals";
import importPlugin from "eslint-plugin-import";

export default [
  {
    files: ["**/*.js"],
    // Byte-for-byte npm output; a fixer here would break its pinned hash.
    ignores: ["**/vendor/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: { import: importPlugin },
    rules: {
      "no-undef": "error",
      "import/named": "error",
      "no-unused-vars": "warn",
    },
    settings: { "import/resolver": { node: { extensions: [".js"] } } },
  },
];
