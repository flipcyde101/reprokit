import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseIssueRef,
  extractIssueSignals,
  normalizeCommandForPlatform,
  initRepro,
  runCheck,
  buildSummary
} from '../src/index.js';
import { runCli } from '../src/cli.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(PROJECT_ROOT, 'bin', 'reprokit.js');

function makeTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reprokit-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'tokenizer.js'),
    'export function tokenize(input) {\n  if (input.includes("::")) throw new Error("Crash on ::");\n  return input.split(":");\n}\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'test', 'tokenizer.test.js'),
    'import test from "node:test";\ntest("placeholder", () => {});\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'test', 'unrelated.test.js'),
    'import test from "node:test";\ntest("other", () => {});\n',
    'utf8'
  );
  return dir;
}

function collectProjectFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.reprokit') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectProjectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

test('parseIssueRef supports owner/repo#num and GitHub issue URLs', () => {
  const shortParsed = parseIssueRef('acme/parser#42');
  assert.equal(shortParsed.owner, 'acme');
  assert.equal(shortParsed.repo, 'parser');
  assert.equal(shortParsed.number, 42);
  assert.equal(shortParsed.ref, 'acme/parser#42');

  const urlParsed = parseIssueRef('https://github.com/acme/parser/issues/42?utm=1#issuecomment-9');
  assert.equal(urlParsed.slug, 'acme/parser');
  assert.equal(urlParsed.number, 42);

  assert.throws(() => parseIssueRef('not-a-valid-ref'), /Invalid issue reference/);
});

test('extractIssueSignals extracts stack trace refs, code blocks, and matching repo tests', (t) => {
  const repoDir = makeTempRepo(t);
  const issue = {
    title: 'Crash when tokenizing double colons',
    body: [
      'Calling tokenize("a::b") throws:',
      '',
      '```text',
      'Error: Crash on ::',
      '    at tokenize (/workspace/app/src/tokenizer.js:2:33)',
      '    at run (src/missing-runner.js:19:5)',
      '```',
      '',
      'Minimal reproduction:',
      '',
      '```js',
      'import { tokenize } from "./src/tokenizer.js";',
      'tokenize("a::b");',
      '```'
    ].join('\n'),
    comments: [
      {
        author: 'alice',
        body: 'Also seen in File "scripts/helper.py", line 14 against https://github.com/acme/parser/issues/42'
      }
    ]
  };

  const signals = extractIssueSignals(issue, repoDir);
  assert.equal(signals.codeBlocks.length, 2);
  assert.equal(signals.codeBlocks[1].lang, 'js');
  assert.equal(signals.codeBlocks[1].kind, 'js');
  assert.match(signals.codeBlocks[1].code, /tokenize\("a::b"\)/);

  const tokenizerRef = signals.stackRefs.find((r) => r.file === 'src/tokenizer.js');
  assert.ok(tokenizerRef, 'Expected src/tokenizer.js stack reference');
  assert.equal(tokenizerRef.line, 2);
  assert.equal(tokenizerRef.column, 33);
  assert.equal(tokenizerRef.existsInRepo, true);

  const missingRef = signals.stackRefs.find((r) => r.file === 'src/missing-runner.js');
  assert.ok(missingRef);
  assert.equal(missingRef.existsInRepo, false);

  const pyRef = signals.stackRefs.find((r) => r.file === 'scripts/helper.py');
  assert.ok(pyRef);
  assert.equal(pyRef.line, 14);

  assert.deepEqual(signals.matchingTests, ['test/tokenizer.test.js']);
});

test('init scaffolds issue JSON, repro .mjs script, and Markdown summary with mocked gh runner', async (t) => {
  const repoDir = makeTempRepo(t);
  let capturedArgs = null;
  const mockGhRunner = async (args) => {
    capturedArgs = args;
    return JSON.stringify({
      number: 77,
      title: ' Crash on double colon input ',
      body: 'Stack:\n    at tokenize (src/tokenizer.js:2:10)\n\n```js\nconsole.log("repro");\n```',
      url: 'https://github.com/acme/parser/issues/77',
      state: 'OPEN',
      author: { login: 'reporter' },
      labels: [{ name: 'bug' }],
      comments: []
    });
  };

  let out = '';
  const code = await runCli(
    ['init', 'https://github.com/acme/parser/issues/77', '--repo-dir', repoDir, '--json'],
    {
      runner: mockGhRunner,
      stdout: (chunk) => {
        out += chunk;
      },
      stderr: () => {}
    }
  );

  assert.equal(code, 0);
  assert.ok(capturedArgs.includes('77'));
  assert.ok(capturedArgs.includes('acme/parser'));

  const parsed = JSON.parse(out);
  assert.equal(parsed.issue.ref, 'acme/parser#77');
  assert.equal(parsed.stackRefs[0].file, 'src/tokenizer.js');
  assert.deepEqual(parsed.matchingTests, ['test/tokenizer.test.js']);

  assert.ok(fs.existsSync(path.join(repoDir, '.reprokit', 'issue-77.json')));
  assert.ok(fs.existsSync(path.join(repoDir, '.reprokit', 'repro-77.mjs')));
  assert.ok(fs.existsSync(path.join(repoDir, '.reprokit', 'issue-77.md')));
});

test('check --phase before -> fix -> check --phase after -> summary workflow', async (t) => {
  const repoDir = makeTempRepo(t);

  await initRepro('acme/parser#88', {
    repoDir,
    runner: async () => ({
      number: 88,
      title: ' Crash on :: delimiter ',
      body: '    at tokenize (src/tokenizer.js:2:33)',
      url: 'https://github.com/acme/parser/issues/88',
      state: 'OPEN',
      author: { login: 'dev' },
      labels: ['bug'],
      comments: []
    })
  });

  const reproScriptRel = '.reprokit/repro-88.mjs';
  const reproScriptAbs = path.join(repoDir, reproScriptRel);
  fs.writeFileSync(
    reproScriptAbs,
    [
      'import assert from "node:assert/strict";',
      'import { tokenize } from "../src/tokenizer.js";',
      'assert.deepEqual(tokenize("a::b"), ["a", "", "b"]);'
    ].join('\n'),
    'utf8'
  );

  const beforeRes = runCheck(reproScriptRel, { repoDir, phase: 'before' });
  assert.equal(beforeRes.ok, true);
  assert.equal(beforeRes.status, 'REPRODUCED');
  assert.notEqual(beforeRes.exitCode, 0);

  // Before fixing, running --phase after must fail verification
  const prematureAfter = runCheck(reproScriptRel, { repoDir, phase: 'after' });
  assert.equal(prematureAfter.ok, false);
  assert.equal(prematureAfter.status, 'STILL_FAILING');

  // Apply fix in src/tokenizer.js
  fs.writeFileSync(
    path.join(repoDir, 'src', 'tokenizer.js'),
    'export function tokenize(input) {\n  return input.split(":");\n}\n',
    'utf8'
  );

  let afterJson = '';
  const afterExit = await runCli(
    ['check', reproScriptRel, '--phase', 'after', '--repo-dir', repoDir, '--json'],
    {
      stdout: (s) => {
        afterJson += s;
      },
      stderr: () => {}
    }
  );
  assert.equal(afterExit, 0);
  const afterParsed = JSON.parse(afterJson);
  assert.equal(afterParsed.status, 'VERIFIED_FIXED');
  assert.equal(afterParsed.exitCode, 0);

  const summary = buildSummary({ repoDir });
  assert.equal(summary.ready, true);
  assert.equal(summary.verdict, 'VERIFIED_BEFORE_AND_AFTER');
  assert.match(summary.markdown, /acme\/parser#88/);
  assert.match(summary.markdown, /REPRODUCED/);
  assert.match(summary.markdown, /VERIFIED_FIXED/);
  assert.equal(summary.markdown.includes('\u2014'), false);
});

test('normalizeCommandForPlatform rewrites leading npm/npx to .cmd on win32', () => {
  assert.equal(normalizeCommandForPlatform('npm test', 'win32'), 'npm.cmd test');
  assert.equal(normalizeCommandForPlatform('npx vitest run', 'win32'), 'npx.cmd vitest run');
  assert.equal(normalizeCommandForPlatform('npm test', 'linux'), 'npm test');
});

test('CLI --help and --version exit 0 via binary entrypoint', () => {
  const helpOut = execFileSync(process.execPath, [BIN_PATH, '--help'], { encoding: 'utf8' });
  assert.match(helpOut, /reprokit init <issueRefOrUrl>/);
  assert.match(helpOut, /reprokit check <reproCmdOrScript>/);

  const versionOut = execFileSync(process.execPath, [BIN_PATH, '--version'], { encoding: 'utf8' });
  assert.equal(versionOut.trim(), '0.1.0');
});

test('repository contains zero U+2014 em dashes across all files', () => {
  const files = collectProjectFiles(PROJECT_ROOT);
  assert.ok(files.length >= 8);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      content.includes('\u2014'),
      false,
      `Found forbidden U+2014 em dash in ${path.relative(PROJECT_ROOT, file)}`
    );
  }
});
