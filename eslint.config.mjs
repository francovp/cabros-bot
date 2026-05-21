import js from "@eslint/js";
import jest from "eslint-plugin-jest";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
    js.configs.recommended,
    eslintConfigPrettier,
    {
        files: ["src/**/*.js", "*.js", "tests/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node
            }
        },
        rules: {
            "brace-style": ["error", "1tbs", { "allowSingleLine": true }],
            "comma-dangle": ["error", "always-multiline"],
            "comma-spacing": "error",
            "comma-style": "error",
            "curly": ["error", "multi-line", "consistent"],
            "dot-location": ["error", "property"],
            "indent": ["error", "tab"],
            "max-nested-callbacks": ["error", { "max": 5 }],
            "max-statements-per-line": ["error", { "max": 2 }],
            "no-console": "off",
            "no-empty-function": "off",
            "no-floating-decimal": "error",
            "no-lonely-if": "error",
            "no-multi-spaces": "error",
            "no-multiple-empty-lines": ["error", { "max": 2, "maxEOF": 1, "maxBOF": 0 }],
            "no-shadow": ["error", { "allow": ["err", "resolve", "reject"] }],
            "no-trailing-spaces": ["error"],
            "no-var": "error",
            "object-curly-spacing": ["error", "always"],
            "prefer-const": "error",
            "quotes": ["error", "single"],
            "semi": ["error", "always"],
            "space-before-blocks": "error",
            "space-before-function-paren": ["error", {
                "anonymous": "never",
                "named": "never",
                "asyncArrow": "always"
            }],
            "space-in-parens": "error",
            "space-infix-ops": "error",
            "space-unary-ops": "error",
            "spaced-comment": "error",
            "yoda": "error",
            "no-unused-vars": "off",
            "no-prototype-builtins": "off",
            "preserve-caught-error": "off",
            "no-useless-assignment": "off",
            "no-useless-escape": "off",
            "no-dupe-class-members": "off",
            "no-async-promise-executor": "off",
            "no-redeclare": "off"
        }
    },
    {
        files: ["tests/**/*.js", "tests/setup.js"],
        plugins: { jest },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
                ...globals.jest,
            }
        },
        rules: {
            ...jest.configs["flat/recommended"].rules,
            "max-nested-callbacks": "off",
            "no-console": "off",
            "no-empty-function": "off",
            "no-redeclare": "off",
            "jest/no-conditional-expect": "off",
            "jest/no-done-callback": "off",
            "no-unused-vars": "off",
            "no-prototype-builtins": "off",
            "no-shadow": "off"
        }
    }
];