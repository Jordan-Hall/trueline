#!/usr/bin/env node
import { runCliAsync } from './index.ts';

const result = await runCliAsync(process.argv.slice(2), Boolean(process.stdout.isTTY));
if (result.stderr.length > 0) process.stderr.write(result.stderr);
if (result.stdout.length > 0) process.stdout.write(result.stdout);
process.exit(result.exitCode);
