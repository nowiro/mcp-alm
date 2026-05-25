/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    'scope-enum': [
      1,
      'always',
      [
        // connectors
        'jira',
        'confluence',
        'figma',
        'sonar',
        'gitlab',
        // shared infrastructure
        'shared',
        'auth',
        'http',
        'write-guard',
        'log',
        'errors',
        // cross-cutting
        'ci',
        'deps',
        'docs',
        'release',
        'security',
        // dodatkowe bramki
        'extract',
      ],
    ],
    'subject-case': [2, 'always', ['sentence-case', 'lower-case']],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [1, 'always', 120],
  },
};
