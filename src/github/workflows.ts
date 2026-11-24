/**
 * Ready-to-use GitHub Actions workflow templates for tamper-proof ratcheting:
 * - `trueline-verify.yml`: runs on `pull_request_target` using the base branch's
 *   pinned trueline binary without executing any untrusted PR code.
 * - `trueline-merge.yml`: runs on `push` to the default branch and automatically
 *   tightens `.trueline.allow` through the GitHub Contents API when debt shrinks.
 */

export function verifyWorkflowTemplate(): string {
  return `name: trueline verify

# Fails a pull request that edits .trueline.allow, weakens trueline.json
# (or alters its "github" governance section), or edits the trueline workflows.
# Only the trueline merge workflow tightens .trueline.allow on the default branch.
#
# pull_request_target runs the base branch's copy of this file without
# installing or executing any code from the pull request.

on: pull_request_target

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: trueline-verify-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install pinned trueline outside workspace
        run: |
          version="\$(node -p "(require('./package.json').devDependencies?.['trueline-lint'] || require('./package.json').dependencies?.['trueline-lint'] || 'latest').replace(/^[\\^~]/, '')")"
          npm install --prefix "\$RUNNER_TEMP/trueline" --no-save --ignore-scripts "trueline-lint@\$version"
      - name: Verify pull request governance
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: |
          node "\$RUNNER_TEMP/trueline/node_modules/trueline-lint/dist/cli/bin.js" github verify \\
            --protect .github/workflows/trueline-verify.yml,.github/workflows/trueline-merge.yml,.github/CODEOWNERS
`;
}

export function mergeWorkflowTemplate(branch = 'main'): string {
  return `name: trueline merge

# The one place .trueline.allow is tightened after a pull request merges.
# Configure a branch ruleset allowing only your GitHub App bot (or CI token)
# to modify .trueline.allow.
#
# After a merge, trueline checks the merged code:
# - Unallowed violations fail the run (never silently added to .trueline.allow).
# - Fixed or shrunk debt is automatically pruned from .trueline.allow via the
#   GitHub Contents API (signed by GitHub) and reported on the merged PR.

on:
  push:
    branches: [${branch}]
    paths-ignore: ['**/.trueline.allow']

concurrency:
  group: trueline-ratchet-\${{ github.sha }}
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  ratchet:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Mint GitHub App token
        id: app
        if: \${{ vars.TRUELINE_APP_ID != '' }}
        uses: actions/create-github-app-token@v2
        with:
          app-id: \${{ vars.TRUELINE_APP_ID }}
          private-key: \${{ secrets.TRUELINE_APP_KEY }}
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install pinned trueline outside workspace
        run: |
          version="\$(node -p "(require('./package.json').devDependencies?.['trueline-lint'] || require('./package.json').dependencies?.['trueline-lint'] || 'latest').replace(/^[\\^~]/, '')")"
          npm install --prefix "\$RUNNER_TEMP/trueline" --no-save --ignore-scripts "trueline-lint@\$version"
      - name: Tighten allowlist on merge
        env:
          GITHUB_TOKEN: \${{ steps.app.outputs.token || github.token }}
        run: |
          node "\$RUNNER_TEMP/trueline/node_modules/trueline-lint/dist/cli/bin.js" github merge --branch ${branch}
`;
}
