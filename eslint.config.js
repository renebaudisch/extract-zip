const tsParser = require("@typescript-eslint/parser");

const {
    defineConfig,
} = require("eslint/config");

module.exports = defineConfig([{
    languageOptions: {
        parser: tsParser,
    },
    "rules": {
        "node/no-unsupported-features/es-syntax": "off",
        "comma-dangle": ["error", "only-multiline"],
        "semi": ["off"],
        "space-before-function-paren": ["off"],
    },
}]);
