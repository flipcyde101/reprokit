import fs from 'node:fs';
import path from 'node:path';
import { parseIssueRef, fetchIssue } from './gh.js';
import { extractCodeBlocks, extractStackRefs, findMatchingTests, extractIssueSignals } from './extract.js';
import { executeReproCommand, normalizeCommandForPlatform } from './runner.js';

export {
  parseIssueRef,
  fetchIssue,
  extractCodeBlocks,
  extractStackRefs,
  findMatchingTests,
  extractIssueSignals,
  executeReproCommand,
  normalizeCommandForPlatform
};

function renderReproScript(issue, signals) {
  const jsBlock = signals.codeBlocks.find((block) => block.kind === 'js');
  const shellBlock = signals.codeBlocks.find((block) => block.kind === 'shell');
  const lines = [
    '#!/usr/bin/env node',
    `// Reproduction script for ${issue.ref}: ${issue.title.replace(/\r?\n/g, ' ')}`,
    `// URL: ${issue.url}`,
    ''
  ];

  if (signals.stackRefs.length > 0) {
    lines.push('// Extracted stack trace locations:');
    for (const ref of signals.stackRefs) {
      const colSuffix = ref.column ? `:${ref.column}` : '';
      const status = ref.existsInRepo ? 'exists' : 'unresolved';
      lines.push(`//   - ${ref.file}:${ref.line}${colSuffix} (${status})`);
    }
    lines.push('');
  }

  if (signals.matchingTests.length > 0) {
    lines.push('// Related repository tests:');
    for (const testFile of signals.matchingTests) {
      lines.push(`//   - ${testFile}`);
    }
    lines.push('');
  }

  if (jsBlock) {
    lines.push('/* Extracted JS snippet from issue:', jsBlock.code.replace(/\*\//g, '* /'), '*/', '');
  } else if (shellBlock) {
    lines.push('/* Extracted shell snippet from issue:', shellBlock.code.replace(/\*\//g, '* /'), '*/', '');
  }

  lines.push(
    '// Replace the failure stub below with the minimal deterministic reproduction.',
    '// Exit non-zero while the bug is present (--phase before) and 0 once fixed (--phase after).',
    `console.error('Reproduction stub failing for ${issue.ref}');`,
    'process.exit(1);',
    ''
  );

  return lines.join('\n');
}

function renderIssueMarkdown(issue, signals, relArtifacts) {
  const lines = [
    `# Issue Reproduction Summary: ${issue.ref}`,
    '',
    `- **Title:** ${issue.title}`,
    `- **URL:** ${issue.url}`,
    `- **State:** ${issue.state}`,
    `- **Author:** ${issue.author}`,
    `- **Labels:** ${issue.labels.length > 0 ? issue.labels.join(', ') : 'none'}`,
    '',
    '## Stack Trace References',
    ''
  ];

  if (signals.stackRefs.length === 0) {
    lines.push('No file/line references detected in issue text.');
  } else {
    for (const ref of signals.stackRefs) {
      const col = ref.column ? `:${ref.column}` : '';
      const tag = ref.existsInRepo ? 'in repo' : 'not found locally';
      lines.push(`- \`${ref.file}:${ref.line}${col}\` (${tag})`);
    }
  }

  lines.push('', '## Matching Test Files', '');
  if (signals.matchingTests.length === 0) {
    lines.push('No matching test files detected in repository.');
  } else {
    for (const testFile of signals.matchingTests) {
      lines.push(`- \`${testFile}\``);
    }
  }

  lines.push('', `## Extracted Code Blocks (${signals.codeBlocks.length})`, '');
  if (signals.codeBlocks.length === 0) {
    lines.push('No fenced code blocks found in issue.');
  } else {
    for (const block of signals.codeBlocks) {
      lines.push(`### Block ${block.index + 1} (${block.lang || 'plain'})`, '', '```' + block.lang, block.code, '```', '');
    }
  }

  lines.push(
    '## Workflow Commands',
    '',
    '```bash',
    `reprokit check ${relArtifacts.reproScript} --phase before`,
    '# implement fix',
    `reprokit check ${relArtifacts.reproScript} --phase after`,
    'reprokit summary',
    '```',
    ''
  );

  return lines.join('\n');
}

export async function initRepro(issueRefOrUrl, options = {}) {
  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const parsed = parseIssueRef(issueRefOrUrl);
  const issue = await fetchIssue(parsed, { runner: options.runner, cwd: repoDir });
  const signals = extractIssueSignals(issue, repoDir);

  const reproDir = path.join(repoDir, '.reprokit');
  fs.mkdirSync(reproDir, { recursive: true });

  const relArtifacts = {
    issueJson: `.reprokit/issue-${issue.number}.json`,
    reproScript: `.reprokit/repro-${issue.number}.mjs`,
    summaryMd: `.reprokit/issue-${issue.number}.md`
  };

  const absArtifacts = {
    issueJson: path.join(repoDir, relArtifacts.issueJson),
    reproScript: path.join(repoDir, relArtifacts.reproScript),
    summaryMd: path.join(repoDir, relArtifacts.summaryMd)
  };

  const record = {
    createdAt: new Date().toISOString(),
    repoDir,
    issue: {
      owner: issue.owner,
      repo: issue.repo,
      slug: issue.slug,
      ref: issue.ref,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      author: issue.author,
      labels: issue.labels
    },
    stackRefs: signals.stackRefs,
    codeBlocks: signals.codeBlocks,
    matchingTests: signals.matchingTests,
    artifacts: relArtifacts
  };

  const markdown = renderIssueMarkdown(issue, signals, relArtifacts);
  const scriptSource = renderReproScript(issue, signals);

  fs.writeFileSync(absArtifacts.issueJson, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.writeFileSync(absArtifacts.reproScript, scriptSource, 'utf8');
  fs.writeFileSync(absArtifacts.summaryMd, markdown, 'utf8');

  return {
    ...record,
    paths: absArtifacts,
    markdown
  };
}

function loadLatestIssueMetadata(reproDir) {
  if (!fs.existsSync(reproDir)) {
    return null;
  }
  const files = fs
    .readdirSync(reproDir)
    .filter((name) => /^issue-\d+\.json$/.test(name))
    .sort();
  if (files.length === 0) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(reproDir, files[files.length - 1]), 'utf8'));
    return raw.issue ?? null;
  } catch {
    return null;
  }
}

export function runCheck(reproCmdOrScript, options = {}) {
  const phase = String(options.phase ?? 'before').toLowerCase();
  if (phase !== 'before' && phase !== 'after') {
    throw new Error(`Invalid --phase "${options.phase}". Expected "before" or "after".`);
  }

  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const commandRunner = options.commandRunner ?? executeReproCommand;
  const runResult = commandRunner(reproCmdOrScript, {
    repoDir,
    platform: options.platform,
    env: options.env,
    timeoutMs: options.timeoutMs
  });

  let status;
  let ok;
  if (phase === 'before') {
    ok = runResult.exitCode !== 0;
    status = ok ? 'REPRODUCED' : 'NOT_REPRODUCED';
  } else {
    ok = runResult.exitCode === 0;
    status = ok ? 'VERIFIED_FIXED' : 'STILL_FAILING';
  }

  const reproDir = path.join(repoDir, '.reprokit');
  fs.mkdirSync(reproDir, { recursive: true });
  const proofPath = path.join(reproDir, 'proof.json');

  let existing = {};
  if (fs.existsSync(proofPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    } catch {
      existing = {};
    }
  }

  const entry = {
    phase,
    status,
    ok,
    command: runResult.command,
    effectiveCommand: runResult.effectiveCommand,
    exitCode: runResult.exitCode,
    durationMs: runResult.durationMs,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    output: runResult.output,
    recordedAt: new Date().toISOString()
  };

  const history = Array.isArray(existing.history) ? [...existing.history, entry] : [entry];
  const issue = existing.issue ?? loadLatestIssueMetadata(reproDir);

  const proof = {
    updatedAt: entry.recordedAt,
    repoDir,
    issue,
    before: phase === 'before' ? entry : existing.before ?? null,
    after: phase === 'after' ? entry : existing.after ?? null,
    history
  };

  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');

  return {
    ...entry,
    proofPath,
    proof
  };
}

export function buildSummary(options = {}) {
  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const reproDir = path.join(repoDir, '.reprokit');
  const proofPath = path.join(reproDir, 'proof.json');

  if (!fs.existsSync(proofPath)) {
    throw new Error(`No proof file found at ${proofPath}. Run "reprokit check <cmd> --phase before" first.`);
  }

  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  const issue = proof.issue ?? loadLatestIssueMetadata(reproDir);
  const before = proof.before ?? null;
  const after = proof.after ?? null;
  const ready = Boolean(before?.status === 'REPRODUCED' && after?.status === 'VERIFIED_FIXED');
  const verdict = ready ? 'VERIFIED_BEFORE_AND_AFTER' : 'INCOMPLETE_PROOF';

  const lines = ['## Reproduction & Fix Proof', ''];
  if (issue) {
    lines.push(`- **Issue:** [${issue.ref}](${issue.url}) - ${issue.title}`);
  }
  lines.push(`- **Verdict:** \`${verdict}\``, '');
  lines.push('| Phase | Command | Exit Code | Status | Duration |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const [label, record] of [
    ['before', before],
    ['after', after]
  ]) {
    if (!record) {
      lines.push(`| \`${label}\` | (not recorded) | - | \`MISSING\` | - |`);
    } else {
      const escapedCmd = String(record.command).replace(/\|/g, '\\|');
      lines.push(
        `| \`${label}\` | \`${escapedCmd}\` | \`${record.exitCode}\` | \`${record.status}\` | ${record.durationMs}ms |`
      );
    }
  }

  for (const [label, record] of [
    ['Before (Bug Reproduced)', before],
    ['After (Fix Verified)', after]
  ]) {
    if (record && record.output) {
      lines.push('', `<details><summary>${label} Output</summary>`, '', '```text', record.output, '```', '</details>');
    }
  }

  lines.push('');
  const markdown = lines.join('\n');

  return {
    verdict,
    ready,
    issue,
    before,
    after,
    proofPath,
    markdown
  };
}
