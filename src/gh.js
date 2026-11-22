import { execFileSync } from 'node:child_process';

const SHORT_REF_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const ISSUE_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

export function parseIssueRef(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Issue reference is required (expected owner/repo#num or GitHub issue URL).');
  }
  const trimmed = input.trim();
  const shortMatch = SHORT_REF_RE.exec(trimmed);
  if (shortMatch) {
    const [, owner, repo, numStr] = shortMatch;
    const number = Number.parseInt(numStr, 10);
    return {
      owner,
      repo,
      number,
      slug: `${owner}/${repo}`,
      ref: `${owner}/${repo}#${number}`,
      url: `https://github.com/${owner}/${repo}/issues/${number}`
    };
  }

  const urlMatch = ISSUE_URL_RE.exec(trimmed);
  if (urlMatch) {
    const [, owner, repo, numStr] = urlMatch;
    const number = Number.parseInt(numStr, 10);
    return {
      owner,
      repo,
      number,
      slug: `${owner}/${repo}`,
      ref: `${owner}/${repo}#${number}`,
      url: `https://github.com/${owner}/${repo}/issues/${number}`
    };
  }

  throw new Error(
    `Invalid issue reference "${trimmed}". Expected owner/repo#num or https://github.com/owner/repo/issues/num.`
  );
}

export function defaultGhRunner(args, options = {}) {
  const stdout = execFileSync('gh', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  return { exitCode: 0, stdout, stderr: '' };
}

export async function fetchIssue(parsedRef, options = {}) {
  const runner = options.runner ?? defaultGhRunner;
  const args = [
    'issue',
    'view',
    String(parsedRef.number),
    '--repo',
    parsedRef.slug,
    '--json',
    'number,title,body,url,state,labels,author,comments'
  ];

  const rawResult = await runner(args, { cwd: options.cwd });
  let payload;
  if (typeof rawResult === 'string') {
    payload = JSON.parse(rawResult);
  } else if (rawResult && typeof rawResult === 'object' && typeof rawResult.stdout === 'string') {
    payload = JSON.parse(rawResult.stdout);
  } else if (rawResult && typeof rawResult === 'object') {
    payload = rawResult;
  } else {
    throw new Error('Unexpected response from gh runner.');
  }

  const labels = Array.isArray(payload.labels)
    ? payload.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
    : [];

  const comments = Array.isArray(payload.comments)
    ? payload.comments.map((comment) => ({
        author: typeof comment?.author === 'string' ? comment.author : comment?.author?.login ?? 'unknown',
        body: String(comment?.body ?? '')
      }))
    : [];

  return {
    owner: parsedRef.owner,
    repo: parsedRef.repo,
    slug: parsedRef.slug,
    ref: parsedRef.ref,
    number: Number(payload.number ?? parsedRef.number),
    title: String(payload.title ?? `Issue #${parsedRef.number}`),
    body: String(payload.body ?? ''),
    url: String(payload.url ?? parsedRef.url),
    state: String(payload.state ?? 'OPEN'),
    author: typeof payload.author === 'string' ? payload.author : payload.author?.login ?? 'unknown',
    labels,
    comments
  };
}
