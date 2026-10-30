/** @type {import('eslint').Linter.FlatConfig} */
module.exports = [
  {
    files: ["**/*.js"],
    rules: {
      "semi": ["error", "always"],
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    },
  },
];
