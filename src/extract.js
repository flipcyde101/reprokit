import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.reprokit',
  'dist',
  'build',
  'coverage',
  '.next',
  '.wrangler',
  '.cache',
  'vendor'
]);

const JS_LANGS = new Set(['js', 'javascript', 'mjs', 'cjs', 'ts', 'typescript', 'node']);
const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'pwsh', 'cmd']);

export function extractCodeBlocks(markdownText) {
  if (typeof markdownText !== 'string' || !markdownText) {
    return [];
  }
  const blocks = [];
  const fenceRe = /^(?:```|~~~)([^\r\n`~]*)\r?\n([\s\S]*?)^(?:```|~~~)[ \t]*$/gm;
  let match;
  let index = 0;
  while ((match = fenceRe.exec(markdownText)) !== null) {
    const rawInfo = match[1].trim();
    const lang = (rawInfo.split(/\s+/)[0] ?? '').toLowerCase();
    const code = match[2].replace(/\r\n/g, '\n').replace(/\n$/, '');
    let kind = 'other';
    if (JS_LANGS.has(lang)) {
      kind = 'js';
    } else if (SHELL_LANGS.has(lang)) {
      kind = 'shell';
    }
    blocks.push({ index, lang, kind, code });
    index += 1;
  }
  return blocks;
}

function normalizeCandidatePath(rawFile) {
  let cleaned = rawFile.trim();
  cleaned = cleaned.replace(/^file:\/\/\/?/i, '');
  cleaned = cleaned.replace(/\\/g, '/');
  cleaned = cleaned.replace(/^[A-Za-z]:\//, '');
  cleaned = cleaned.replace(/^\.\//, '');
  cleaned = cleaned.replace(/^\/+/, '');
  return cleaned;
}

function resolveInRepo(cleanedPath, repoDir) {
  if (!repoDir) {
    return { relativePath: cleanedPath, existsInRepo: false };
  }
  const absRepo = path.resolve(repoDir);
  const segments = cleanedPath.split('/').filter(Boolean);

  for (let i = 0; i < segments.length; i += 1) {
    const subPath = segments.slice(i).join('/');
    const candidateAbs = path.resolve(absRepo, subPath);
    const rel = path.relative(absRepo, candidateAbs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      try {
        if (fs.statSync(candidateAbs).isFile()) {
          return { relativePath: rel.replace(/\\/g, '/'), existsInRepo: true };
        }
      } catch {
        // Ignore missing path
      }
    }
  }

  return { relativePath: cleanedPath, existsInRepo: false };
}

export function extractStackRefs(text, repoDir) {
  if (typeof text !== 'string' || !text) {
    return [];
  }

  const sanitized = text.replace(/https?:\/\/[^\s)>\]"']+/gi, ' ');
  const seen = new Set();
  const refs = [];

  const addRef = (raw, rawFile, lineStr, colStr) => {
    if (!rawFile || rawFile.startsWith('node:')) {
      return;
    }
    const cleaned = normalizeCandidatePath(rawFile);
    if (!cleaned || cleaned.includes('..')) {
      return;
    }
    const line = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(line) || line <= 0) {
      return;
    }
    const column = colStr ? Number.parseInt(colStr, 10) : null;
    const { relativePath, existsInRepo } = resolveInRepo(cleaned, repoDir);
    const key = `${relativePath}:${line}:${column ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    refs.push({
      raw: raw.trim(),
      file: relativePath,
      line,
      column,
      existsInRepo
    });
  };

  const pyRe = /File "([^"\r\n]+)", line (\d+)/g;
  let match;
  while ((match = pyRe.exec(sanitized)) !== null) {
    addRef(match[0], match[1], match[2], null);
  }

  const fileLineRe =
    /(?:file:\/\/\/?[A-Za-z]:\/|file:\/\/\/|[A-Za-z]:[\\/])?([A-Za-z0-9_./\\-]+?\.(?:[mc]?[jt]sx?|py|go|rs|java|rb|php|cs|cpp|c|h|hpp|vue|svelte)):(\d+)(?::(\d+))?/g;
  while ((match = fileLineRe.exec(sanitized)) !== null) {
    const fullMatch = match[0];
    const rawFile = fullMatch.slice(0, fullMatch.indexOf(`:${match[2]}`));
    addRef(fullMatch, rawFile, match[2], match[3] ?? null);
  }

  return refs;
}

function walkRepoFiles(repoDir, maxFiles = 5000) {
  if (!repoDir || !fs.existsSync(repoDir)) {
    return [];
  }
  const root = path.resolve(repoDir);
  const results = [];
  const stack = [root];

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const rel = path.relative(root, path.join(current, entry.name)).replace(/\\/g, '/');
        results.push(rel);
      }
    }
  }
  return results;
}

function isTestFile(relPath) {
  return (
    /(?:^|\/)(?:test|tests|__tests__)\//i.test(relPath) ||
    /\.(?:test|spec)\.[mc]?[jt]sx?$/i.test(relPath) ||
    /_test\.(?:go|py|rs)$/i.test(relPath) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(relPath)
  );
}

function extractStem(filePath) {
  const base = path.posix.basename(filePath);
  return base
    .replace(/\.(?:test|spec)\.[A-Za-z0-9]+$/i, '')
    .replace(/_test\.[A-Za-z0-9]+$/i, '')
    .replace(/^test_/i, '')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .toLowerCase();
}

export function findMatchingTests(repoDir, stackRefs = [], issueText = '') {
  const allFiles = walkRepoFiles(repoDir);
  const testFiles = allFiles.filter(isTestFile);
  if (testFiles.length === 0) {
    return [];
  }

  const stackStems = new Set();
  const stackPaths = new Set();
  const stackDirTokens = new Set();

  for (const ref of stackRefs) {
    stackPaths.add(ref.file.toLowerCase());
    const stem = extractStem(ref.file);
    if (stem && stem !== 'index') {
      stackStems.add(stem);
    }
    for (const part of path.posix.dirname(ref.file).split('/')) {
      if (part && part !== '.' && part !== 'src' && part !== 'lib') {
        stackDirTokens.add(part.toLowerCase());
      }
    }
  }

  const lowerIssue = String(issueText ?? '').toLowerCase();
  const scored = [];

  for (const testFile of testFiles) {
    let score = 0;
    const lowerTest = testFile.toLowerCase();
    const testStem = extractStem(testFile);

    if (stackPaths.has(lowerTest)) {
      score += 12;
    }
    if (testStem && stackStems.has(testStem)) {
      score += 10;
    }
    if (lowerIssue.includes(lowerTest) || lowerIssue.includes(path.posix.basename(lowerTest))) {
      score += 6;
    } else if (testStem.length >= 3 && lowerIssue.includes(testStem)) {
      score += 3;
    }
    for (const dirToken of stackDirTokens) {
      if (lowerTest.includes(`/${dirToken}/`) || lowerTest.startsWith(`${dirToken}/`)) {
        score += 2;
      }
    }

    if (score > 0) {
      scored.push({ file: testFile, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.map((item) => item.file);
}

export function extractIssueSignals(issue, repoDir) {
  const combinedParts = [issue.title ?? '', issue.body ?? ''];
  if (Array.isArray(issue.comments)) {
    for (const comment of issue.comments) {
      if (comment?.body) {
        combinedParts.push(comment.body);
      }
    }
  }
  const combinedText = combinedParts.join('\n\n');
  const codeBlocks = extractCodeBlocks(combinedText);
  const stackRefs = extractStackRefs(combinedText, repoDir);
  const matchingTests = findMatchingTests(repoDir, stackRefs, combinedText);
  return {
    stackRefs,
    codeBlocks,
    matchingTests
  };
}
