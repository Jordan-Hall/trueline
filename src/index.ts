/**
 * Programmatic API for `trueline`.
 */

import { AllowList } from './allow/index.ts';
import { analyzeWorkspace, type AnalyzeResult } from './analyzer/index.ts';
import {
  renderBadgeJson,
  renderDiagnostics,
  type OutputFormat,
} from './format/index.ts';
import {
  detectConfigWeakening,
  verifyPullRequestPolicy,
  type PullRequestPolicyInput,
} from './github/policy.ts';
import { formatExplanation, resolveScope, runLints } from './lint/index.ts';
import type {
  Diagnostic,
  GithubGovernanceConfig,
  TruelineConfig,
} from './model/types.ts';
import { loadConfig } from './workspace/config.ts';
import { discoverWorkspace } from './workspace/discover.ts';

export {
  AllowList,
  analyzeWorkspace,
  detectConfigWeakening,
  discoverWorkspace,
  formatExplanation,
  loadConfig,
  renderBadgeJson,
  renderDiagnostics,
  resolveScope,
  runLints,
  verifyPullRequestPolicy,
};

export type {
  AnalyzeResult,
  Diagnostic,
  GithubGovernanceConfig,
  OutputFormat,
  PullRequestPolicyInput,
  TruelineConfig,
};
