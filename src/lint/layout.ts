/**
 * `wide-directory` and `long-file`: deterministic filesystem layout limits.
 *
 * A reader takes in a directory by scanning its listing (`maxDirectoryMembers`,
 * default 15) and navigates a file by scrolling (`maxFileLines`, default 1500).
 */

import type { Diagnostic, FileInfo, Model, NodeId, TruelineConfig } from '../model/types.ts';
import { inScope, listed } from './helpers.ts';

export function checkLayout(
  model: Model,
  config: TruelineConfig,
  scope: NodeId | undefined,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const concerned = (file: FileInfo): boolean =>
    inScope(model.tree, scope, file.moduleNode);

  if (config.lints['long-file']) {
    for (const file of model.files) {
      if (file.lines > config.maxFileLines && concerned(file)) {
        diagnostics.push({
          lint: 'long-file',
          key: file.path,
          message: `\`${file.path}\` is long: it has ${file.lines} lines, more than ${config.maxFileLines}`,
          location: { file: file.path, line: 1, column: 1 },
          notes: [],
          picture: {
            kind: 'bar',
            label: 'lines',
            length: file.lines,
            most: config.maxFileLines,
          },
        });
      }
    }
  }

  if (config.lints['wide-directory']) {
    const dirs = new Map<string, { members: Set<string>; inScope: boolean }>();
    for (const file of model.files) {
      const fileConcerned = concerned(file);
      for (const [dir, member] of holdersOf(file.path)) {
        let entry = dirs.get(dir);
        if (entry === undefined) {
          entry = { members: new Set(), inScope: false };
          dirs.set(dir, entry);
        }
        entry.members.add(member);
        entry.inScope = entry.inScope || fileConcerned;
      }
    }

    for (const [dir, entry] of dirs) {
      if (!entry.inScope || entry.members.size <= config.maxDirectoryMembers) {
        continue;
      }
      diagnostics.push(
        buildWideDirectory(dir, entry.members, config),
      );
    }
  }

  return diagnostics;
}

function holdersOf(path: string): [string, string][] {
  const parts = path.split('/').filter((p) => p.length > 0);
  const out: [string, string][] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/');
    const member = i < parts.length - 1 ? `${parts[i]}/` : parts[i]!;
    out.push([dir, member]);
  }
  return out;
}

function buildWideDirectory(
  directory: string,
  members: ReadonlySet<string>,
  config: TruelineConfig,
): Diagnostic {
  const shown = directory.length === 0 ? './' : `${directory}/`;
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const m of [...members].sort()) {
    if (m.endsWith('/')) subdirs.push(m);
    else files.push(m);
  }

  const notes: string[] = [];
  if (files.length > 0) {
    notes.push(
      `${files.length} ${files.length === 1 ? 'file' : 'files'}: ${listed(files, config.heldInMind)}`,
    );
  }
  if (subdirs.length > 0) {
    notes.push(
      `${subdirs.length} ${subdirs.length === 1 ? 'directory' : 'directories'}: ${listed(subdirs, config.heldInMind)}`,
    );
  }

  const indexFile = ['index.ts', 'index.tsx', 'index.js', 'index.mjs'].find(
    (name) => members.has(name),
  );
  const location =
    indexFile !== undefined
      ? {
          file: directory.length === 0 ? indexFile : `${directory}/${indexFile}`,
          line: 1,
          column: 1,
        }
      : undefined;

  return {
    lint: 'wide-directory',
    key: shown,
    message: `\`${shown}\` is wide: it holds ${members.size} files and directories, more than ${config.maxDirectoryMembers}`,
    location,
    notes,
    picture: {
      kind: 'bar',
      label: 'holds',
      length: members.size,
      most: config.maxDirectoryMembers,
    },
  };
}
