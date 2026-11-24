/**
 * Pure tamper-protection policy checks for `trueline github verify`.
 *
 * Governance model:
 * - Pull requests may never edit `.trueline.allow` (only the merge workflow tightens it).
 * - Pull requests may never edit protected workflow / CODEOWNERS files.
 * - Pull requests may never weaken `trueline.json` (change `github`, disable lints,
 *   raise thresholds, add ignores, or remove layer rules).
 */

import { ALL_LINTS, type TruelineConfig } from '../model/types.ts';

export interface PullRequestPolicyInput {
  readonly changedFiles: readonly string[];
  readonly author: string | undefined;
  readonly botLogin: string | undefined;
  readonly protectedPaths: readonly string[];
  readonly configChanges: readonly {
    readonly path: string;
    readonly base: TruelineConfig;
    readonly head: TruelineConfig | undefined;
  }[];
}

export function verifyPullRequestPolicy(
  input: PullRequestPolicyInput,
): string[] {
  const violations: string[] = [];

  // The configured bot is permitted to commit tightened allowlists on merge.
  if (
    input.botLogin !== undefined &&
    input.author !== undefined &&
    input.author === input.botLogin
  ) {
    return violations;
  }

  const protectedSet = new Set(
    input.protectedPaths.map((p) => p.replaceAll('\\', '/').replace(/^\.\//, '')),
  );

  for (const rawPath of input.changedFiles) {
    const file = rawPath.replaceAll('\\', '/');
    if (file === '.trueline.allow' || file.endsWith('/.trueline.allow')) {
      violations.push(
        `\`${file}\` cannot be modified in a pull request (allowlists are tightened automatically on merge).`,
      );
    }
    if (protectedSet.has(file)) {
      violations.push(
        `\`${file}\` is protected by trueline governance and cannot be modified in this pull request.`,
      );
    }
  }

  for (const change of input.configChanges) {
    if (change.head === undefined) {
      violations.push(`\`${change.path}\` cannot be deleted in a pull request.`);
      continue;
    }
    for (const reason of detectConfigWeakening(change.base, change.head)) {
      violations.push(`\`${change.path}\`: ${reason}`);
    }
  }

  return violations;
}

export function detectConfigWeakening(
  base: TruelineConfig,
  head: TruelineConfig,
): string[] {
  const issues: string[] = [];

  if (JSON.stringify(base.github ?? null) !== JSON.stringify(head.github ?? null)) {
    issues.push('cannot modify the `github` governance section in a pull request');
  }

  for (const lint of ALL_LINTS) {
    if (base.lints[lint] && !head.lints[lint]) {
      issues.push(`cannot disable lint \`${lint}\``);
    }
  }

  checkUpperBound(issues, 'heldInMind', base.heldInMind, head.heldInMind);
  checkUpperBound(issues, 'maxDirectoryMembers', base.maxDirectoryMembers, head.maxDirectoryMembers);
  checkUpperBound(issues, 'maxFileLines', base.maxFileLines, head.maxFileLines);
  checkUpperBound(issues, 'maxFunctionLines', base.maxFunctionLines, head.maxFunctionLines);
  checkUpperBound(issues, 'maxNestingDepth', base.maxNestingDepth, head.maxNestingDepth);
  checkUpperBound(issues, 'maxParameters', base.maxParameters, head.maxParameters);
  checkUpperBound(issues, 'minCloneTokens', base.minCloneTokens, head.minCloneTokens);

  if (head.breakEven < base.breakEven) {
    issues.push(`cannot lower \`breakEven\` from ${base.breakEven} to ${head.breakEven}`);
  }
  if (!base.ignoreTypeOnlyImports && head.ignoreTypeOnlyImports) {
    issues.push('cannot enable `ignoreTypeOnlyImports` to weaken cycle/layer checks');
  }

  const baseIgnores = new Set(base.ignore);
  for (const pat of head.ignore) {
    if (!baseIgnores.has(pat)) {
      issues.push(`cannot add ignore pattern \`${pat}\``);
    }
  }

  if (base.layers.preset === 'clean-architecture' && head.layers.preset === 'none') {
    issues.push('cannot disable `layers.preset: "clean-architecture"`');
  }
  if (base.layers.noPackageToApp && !head.layers.noPackageToApp) {
    issues.push('cannot disable `layers.noPackageToApp`');
  }

  const headSlices = new Set(head.layers.featureSlices);
  for (const slice of base.layers.featureSlices) {
    if (!headSlices.has(slice)) {
      issues.push(`cannot remove feature slice boundary \`${slice}\``);
    }
  }

  const headRulesByName = new Map(head.layers.rules.map((r) => [r.name, r]));
  for (const baseRule of base.layers.rules) {
    const headRule = headRulesByName.get(baseRule.name);
    if (headRule === undefined) {
      issues.push(`cannot remove layer rule \`${baseRule.name}\``);
      continue;
    }
    if (JSON.stringify(baseRule) !== JSON.stringify(headRule)) {
      issues.push(`cannot alter existing layer rule \`${baseRule.name}\``);
    }
  }

  return issues;
}

function checkUpperBound(
  issues: string[],
  field: string,
  baseVal: number,
  headVal: number,
): void {
  if (headVal > baseVal) {
    issues.push(`cannot raise \`${field}\` from ${baseVal} to ${headVal}`);
  }
}
