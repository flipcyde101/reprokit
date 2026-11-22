import fs from 'node:fs';
import { initRepro, runCheck, buildSummary } from './index.js';

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));

export const HELP_TEXT = `reprokit v${pkg.version}
Zero-dependency GitHub issue reproduction scaffolder and fix proof recorder.

Usage:
  reprokit init <issueRefOrUrl> [--repo-dir <dir>] [--json]
  reprokit check <reproCmdOrScript> [--phase before|after] [--repo-dir <dir>] [--json]
  reprokit summary [--repo-dir <dir>] [--json]
  reprokit --help | --version

Options:
  --repo-dir <dir>        Target repository directory (default: current directory)
  --phase <before|after>  Expected verification phase for check (default: before)
  --json                  Emit structured JSON output
  -h, --help              Show this help text
  -v, --version           Show package version
`;

function parseCliArgs(argv) {
  const positionals = [];
  const flags = {
    json: false,
    help: false,
    version: false,
    repoDir: undefined,
    phase: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg === '-v' || arg === '--version') {
      flags.version = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--repo-dir') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --repo-dir');
      }
      flags.repoDir = argv[++i];
    } else if (arg.startsWith('--repo-dir=')) {
      flags.repoDir = arg.slice('--repo-dir='.length);
    } else if (arg === '--phase') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --phase');
      }
      flags.phase = argv[++i];
    } else if (arg.startsWith('--phase=')) {
      flags.phase = arg.slice('--phase='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

export async function runCli(argv, options = {}) {
  const writeOut = options.stdout ?? ((msg) => process.stdout.write(msg));
  const writeErr = options.stderr ?? ((msg) => process.stderr.write(msg));
  const baseCwd = options.cwd ?? process.cwd();

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    writeErr(`Error: ${err.message}\n`);
    return 2;
  }

  const { positionals, flags } = parsed;
  if (flags.version) {
    writeOut(`${pkg.version}\n`);
    return 0;
  }
  if (flags.help || positionals.length === 0) {
    writeOut(HELP_TEXT);
    return 0;
  }

  const command = positionals[0];
  const repoDir = flags.repoDir ?? baseCwd;

  try {
    if (command === 'init') {
      const issueRef = positionals[1];
      if (!issueRef) {
        writeErr('Error: Missing <issueRefOrUrl> for "reprokit init".\n');
        return 2;
      }
      const result = await initRepro(issueRef, {
        repoDir,
        runner: options.runner
      });
      if (flags.json) {
        writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        writeOut(
          [
            `Initialized ${result.issue.ref}: ${result.issue.title}`,
            `  Issue JSON:     ${result.artifacts.issueJson}`,
            `  Repro script:   ${result.artifacts.reproScript}`,
            `  Summary MD:     ${result.artifacts.summaryMd}`,
            `  Stack refs:     ${result.stackRefs.length}`,
            `  Code blocks:    ${result.codeBlocks.length}`,
            `  Matching tests: ${result.matchingTests.length}`
          ].join('\n') + '\n'
        );
      }
      return 0;
    }

    if (command === 'check') {
      const reproTarget = positionals[1];
      if (!reproTarget) {
        writeErr('Error: Missing <reproCmdOrScript> for "reprokit check".\n');
        return 2;
      }
      const result = runCheck(reproTarget, {
        repoDir,
        phase: flags.phase ?? 'before',
        commandRunner: options.commandRunner,
        platform: options.platform,
        env: options.env
      });
      if (flags.json) {
        writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        writeOut(
          `[${result.status}] phase=${result.phase} exit=${result.exitCode} duration=${result.durationMs}ms (${result.proofPath})\n`
        );
      }
      return result.ok ? 0 : 1;
    }

    if (command === 'summary') {
      const result = buildSummary({ repoDir });
      if (flags.json) {
        writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        writeOut(result.markdown);
      }
      return 0;
    }

    writeErr(`Error: Unknown command "${command}". Run "reprokit --help" for usage.\n`);
    return 2;
  } catch (err) {
    writeErr(`Error: ${err.message}\n`);
    return 2;
  }
}
