// This package's own dead-code graph: its entry points are the files behind `exports`.
import { knip, packageEntries } from './src/knip.ts';

export default knip({
    entry: packageEntries().map((file) => `${file}!`),
    project: ['src/**/*.ts!', 'scripts/**/*.{js,ts}', 'test/**/*.js'],
    ignoreDependencies: [
        // The CLIs this package installs for the projects that depend on it, which run them by name.
        '@commitlint/cli',
        'husky',
        'lint-staged',
        // Resolved by name at run time: jscpd's bin by the duplication gate, postcss-scss by stylelint.ts.
        'jscpd',
        'postcss-scss',
    ],
});
