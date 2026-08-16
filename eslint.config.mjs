/**
 * ESLint configuration for the project.
 * 
 * See https://eslint.style and https://typescript-eslint.io for additional linting options.
 */
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
	{
		ignores: [
			'**/.vscode-test',
			'**/out',
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...tseslint.configs.stylistic,
	{
		// Build scripts and tests are plain Node programs.
		files: ['scripts/**/*.mjs', 'server/src/test/**/*.ts'],
		languageOptions: {
			globals: {
				console: 'readonly',
				process: 'readonly',
			}
		}
	},
	{
		plugins: {
			'@stylistic': stylistic
		},
		rules: {
			// `multi-line` still requires braces for real blocks but permits the
			// single-line guard clauses used throughout the server.
			'curly': ['warn', 'multi-line'],
			'@stylistic/semi': ['warn', 'always'],
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					'selector': 'import',
					'format': ['camelCase', 'PascalCase']
				}
			],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					'argsIgnorePattern': '^_'
				}
			]
		}
	}
);