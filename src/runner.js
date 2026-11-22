import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CAPTURED_CHARS = 16_384;

export function normalizeCommandForPlatform(command, platform = process.platform) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) {
    throw new Error('Reproduction command or script path is required.');
  }
  if (platform === 'win32') {
    return trimmed.replace(/^(npm|npx)(?=\s|$)/i, (match) => `${match}.cmd`);
  }
  return trimmed;
}

function truncateOutput(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  if (normalized.length <= MAX_CAPTURED_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_CAPTURED_CHARS)}\n...[truncated]`;
}

export function executeReproCommand(reproCmdOrScript, options = {}) {
  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const rawInput = String(reproCmdOrScript ?? '').trim();
  if (!rawInput) {
    throw new Error('Reproduction command or script path is required.');
  }

  const candidateScript = path.resolve(repoDir, rawInput);
  const isExistingScript = fs.existsSync(candidateScript) && fs.statSync(candidateScript).isFile();

  const started = Date.now();
  let result;
  let effectiveCommand = rawInput;

  if (isExistingScript) {
    const ext = path.extname(candidateScript).toLowerCase();
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      effectiveCommand = `${process.execPath} ${rawInput}`;
      result = spawnSync(process.execPath, [candidateScript], {
        cwd: repoDir,
        env: options.env ?? process.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs
      });
    } else if (ext === '.sh') {
      effectiveCommand = `sh ${rawInput}`;
      result = spawnSync('sh', [candidateScript], {
        cwd: repoDir,
        env: options.env ?? process.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs
      });
    } else {
      const normalized = normalizeCommandForPlatform(rawInput, platform);
      effectiveCommand = normalized;
      result = spawnSync(normalized, {
        cwd: repoDir,
        env: options.env ?? process.env,
        shell: true,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs
      });
    }
  } else {
    const normalized = normalizeCommandForPlatform(rawInput, platform);
    effectiveCommand = normalized;
    result = spawnSync(normalized, {
      cwd: repoDir,
      env: options.env ?? process.env,
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs
    });
  }

  const durationMs = Math.max(0, Date.now() - started);
  const stdout = truncateOutput(result.stdout ?? '');
  const errorSuffix = result.error ? `\n${result.error.message}` : '';
  const stderr = truncateOutput(`${result.stderr ?? ''}${errorSuffix}`);
  const exitCode = typeof result.status === 'number' ? result.status : result.error ? 127 : 1;

  return {
    command: rawInput,
    effectiveCommand,
    exitCode,
    durationMs,
    stdout,
    stderr,
    output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
  };
}
