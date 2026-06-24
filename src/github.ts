import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip = require('adm-zip');

const API = 'https://api.github.com';

export interface Run {
    id: number;
    name: string;
    display_title: string;
    head_branch: string;
    run_number: number;
    status: string;
    conclusion: string | null;
    created_at: string;
    html_url: string;
}

export interface Failure {
    env: string; // deploy environment / shard the result came from (e.g. "dev", "prod")
    file: string;
    title: string;
    project: string;
    status: string;
    error: string;
    screenshot?: string; // local fs path (mapped to a webview uri by the panel)
    video?: string;
    trace?: string;
}

export async function getToken(createIfNone = true): Promise<string | undefined> {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone });
    return session?.accessToken;
}

export function detectRepo(): { owner: string; repo: string } | undefined {
    const override = vscode.workspace.getConfiguration('pwci').get<string>('repo');
    if (override && override.includes('/')) {
        const [owner, repo] = override.split('/');
        return { owner, repo };
    }
    // Env fallback — handy for the Extension Development Host (set via launch.json),
    // so you don't have to open the target repo's folder (VS Code won't open the
    // same folder in two windows anyway).
    const envRepo = process.env.PWCI_REPO;
    if (envRepo && envRepo.includes('/')) {
        const [owner, repo] = envRepo.split('/');
        return { owner, repo };
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
            const url = cp
                .execSync('git config --get remote.origin.url', { cwd: folder.uri.fsPath })
                .toString()
                .trim();
            const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
            if (m) {
                return { owner: m[1], repo: m[2] };
            }
        } catch {
            /* not a git repo / no origin */
        }
    }
    return undefined;
}

async function api<T>(token: string, url: string): Promise<T> {
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!res.ok) {
        throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
    }
    return (await res.json()) as T;
}

export async function listRuns(token: string, owner: string, repo: string): Promise<Run[]> {
    const workflow = vscode.workspace.getConfiguration('pwci').get<string>('workflow');
    const base = workflow
        ? `${API}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`
        : `${API}/repos/${owner}/${repo}/actions/runs`;
    const data = await api<{ workflow_runs: Run[] }>(token, `${base}?per_page=40`);
    return data.workflow_runs;
}

interface Artifact {
    id: number;
    name: string;
}

async function downloadArtifact(
    token: string,
    owner: string,
    repo: string,
    artifactId: number,
    destDir: string,
): Promise<void> {
    // GitHub 302-redirects to a signed storage URL; fetch follows it and (per
    // undici) drops the Authorization header on the cross-origin hop, which is
    // exactly what the signed URL wants.
    const res = await fetch(`${API}/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
        throw new Error(`Artifact ${artifactId} download failed: ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Async extract so a large artifact doesn't block the extension host.
    await new Promise<void>((resolve, reject) => {
        new AdmZip(buf).extractAllToAsync(destDir, true, false, (err) =>
            err ? reject(err) : resolve(),
        );
    });
}

// Parsed failures per run id — a completed run's artifacts never change, so
// this is safe to keep for the life of the session (bust it with `force`).
const failuresCache = new Map<number, Failure[]>();

export function clearFailuresCache(runId?: number) {
    if (runId === undefined) {
        failuresCache.clear();
    } else {
        failuresCache.delete(runId);
    }
}

export async function getRunFailures(
    token: string,
    owner: string,
    repo: string,
    runId: number,
    workRoot: string,
    force = false,
): Promise<Failure[]> {
    if (!force && failuresCache.has(runId)) {
        return failuresCache.get(runId)!;
    }

    const runDir = path.join(workRoot, `run-${runId}`);
    // v2 = per-environment subdir layout. Bumping the marker name invalidates
    // any run dirs downloaded by the old single-artifact layout so they get
    // re-fetched into runDir/<env>/{json,media} instead of being misparsed.
    const marker = path.join(runDir, '.complete-v2');

    // Reuse a previously-downloaded run dir across sessions; only (re)download
    // when it's missing/incomplete or a refresh was requested.
    if (force || !fs.existsSync(marker)) {
        fs.rmSync(runDir, { recursive: true, force: true });
        fs.mkdirSync(runDir, { recursive: true });

        const { artifacts } = await api<{ artifacts: Artifact[] }>(
            token,
            `${API}/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
        );

        // A run can deploy to several environments (e.g. dev runs the full e2e
        // suite, prod runs only @prod-safe), each uploading its own
        // playwright-json-<env> + playwright-test-results-<env> pair. Re-runs
        // also produce duplicate names. Group by the <env> suffix and keep the
        // newest (highest id) of each kind so we fetch EVERY environment's media.
        const groups = new Map<string, { json?: Artifact; media?: Artifact }>();
        const add = (kind: 'json' | 'media', prefix: RegExp, a: Artifact) => {
            const env = a.name.replace(prefix, '').replace(/^[-_]+/, '') || 'default';
            const g = groups.get(env) ?? {};
            if (!g[kind] || a.id > g[kind]!.id) {
                g[kind] = a;
                groups.set(env, g);
            }
        };
        for (const a of artifacts) {
            if (/playwright-json/i.test(a.name)) {
                add('json', /playwright-json/i, a);
            } else if (/playwright-test-results/i.test(a.name)) {
                add('media', /playwright-test-results/i, a);
            }
        }

        // Download each environment's artifacts into its own subdir so paths
        // from different suites can't collide.
        for (const [env, g] of groups) {
            const jsonDir = path.join(runDir, env, 'json');
            const mediaDir = path.join(runDir, env, 'media');
            fs.mkdirSync(jsonDir, { recursive: true });
            fs.mkdirSync(mediaDir, { recursive: true });
            if (g.media) {
                await downloadArtifact(token, owner, repo, g.media.id, mediaDir);
            }
            if (g.json) {
                await downloadArtifact(token, owner, repo, g.json.id, jsonDir);
            }
        }
        fs.writeFileSync(marker, new Date().toISOString());
    }

    // Parse every environment subdir we downloaded and merge.
    const failures: Failure[] = [];
    for (const env of fs.readdirSync(runDir)) {
        const envDir = path.join(runDir, env);
        if (!fs.statSync(envDir).isDirectory()) {
            continue;
        }
        failures.push(...parseRunDir(env, path.join(envDir, 'json'), path.join(envDir, 'media')));
    }
    // Failures first, then grouped by env, for a stable display order.
    failures.sort(
        (a, b) =>
            Number(b.status !== 'passed') - Number(a.status !== 'passed') ||
            a.env.localeCompare(b.env),
    );
    failuresCache.set(runId, failures);
    return failures;
}

function parseRunDir(env: string, jsonDir: string, mediaDir: string): Failure[] {
    const jsonPath = findFile(jsonDir, (f) => f.endsWith('.json'));
    if (jsonPath) {
        return failuresFromReport(env, JSON.parse(fs.readFileSync(jsonPath, 'utf8')), mediaDir);
    }
    // Older run (before the JSON reporter) — surface whatever media exists.
    return failuresFromMedia(env, mediaDir);
}

function failuresFromReport(env: string, report: any, mediaDir: string): Failure[] {
    const out: Failure[] = [];
    const visitFile = (fileSuite: any) => {
        const file: string = fileSuite.title ?? '';
        const walk = (suite: any, prefix: string[]) => {
            for (const spec of suite.specs ?? []) {
                for (const test of spec.tests ?? []) {
                    const result = (test.results ?? []).slice(-1)[0];
                    if (!result || result.status === 'skipped') {
                        continue;
                    }
                    const atts = result.attachments ?? [];
                    out.push({
                        env,
                        file,
                        title: [...prefix, spec.title].filter(Boolean).join(' › '),
                        project: test.projectName ?? '',
                        status: result.status,
                        error:
                            result.status === 'passed'
                                ? ''
                                : stripAnsi(
                                      `${result.error?.message ?? ''}\n${result.error?.stack ?? ''}`,
                                  ).trim(),
                        screenshot: resolveAttachment(atts, 'screenshot', mediaDir),
                        video: resolveAttachment(atts, 'video', mediaDir),
                        trace: resolveAttachment(atts, 'trace', mediaDir),
                    });
                }
            }
            for (const child of suite.suites ?? []) {
                walk(child, [...prefix, child.title]);
            }
        };
        walk(fileSuite, []);
    };
    for (const suite of report.suites ?? []) {
        visitFile(suite);
    }
    return out;
}

function resolveAttachment(atts: any[], name: string, mediaDir: string): string | undefined {
    const a = atts.find((x) => x.name === name && x.path);
    if (!a) {
        return undefined;
    }
    const norm = String(a.path).replace(/\\/g, '/');
    const idx = norm.lastIndexOf('test-results/');
    const rel = idx >= 0 ? norm.slice(idx + 'test-results/'.length) : path.basename(norm);
    const candidate = path.join(mediaDir, rel);
    if (fs.existsSync(candidate)) {
        return candidate;
    }
    return findFile(mediaDir, (f) => path.basename(f) === path.basename(norm));
}

function failuresFromMedia(env: string, mediaDir: string): Failure[] {
    const out: Failure[] = [];
    if (!fs.existsSync(mediaDir)) {
        return out;
    }
    for (const dir of fs.readdirSync(mediaDir)) {
        const full = path.join(mediaDir, dir);
        if (!fs.statSync(full).isDirectory()) {
            continue;
        }
        const files = fs.readdirSync(full);
        const png = files.find((f) => /^test-failed.*\.png$/.test(f));
        const vid = files.find((f) => f.endsWith('.webm'));
        const trace = files.find((f) => f === 'trace.zip');
        const ctx = files.find((f) => f === 'error-context.md');
        const failed = Boolean(png || trace || ctx);
        // Keep passing tests (just a video) so they can be viewed via "show all";
        // only skip dirs that have nothing useful.
        if (!failed && !vid) {
            continue;
        }
        out.push({
            env,
            file: '',
            title: dir,
            project: '',
            status: failed ? 'failed' : 'passed',
            error: !failed
                ? ''
                : ctx
                  ? '(no JSON report on this run — showing the page snapshot)\n\n' +
                    fs.readFileSync(path.join(full, ctx), 'utf8').slice(0, 4000)
                  : '(no error detail — this run predates the JSON reporter)',
            screenshot: png ? path.join(full, png) : undefined,
            video: vid ? path.join(full, vid) : undefined,
            trace: trace ? path.join(full, trace) : undefined,
        });
    }
    return out;
}

function findFile(dir: string, pred: (f: string) => boolean): string | undefined {
    if (!fs.existsSync(dir)) {
        return undefined;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, pred);
            if (found) {
                return found;
            }
        } else if (pred(full)) {
            return full;
        }
    }
    return undefined;
}

function stripAnsi(s: string): string {
    const esc = String.fromCharCode(27);
    return s.replace(new RegExp(esc + '\\[[0-9;]*m', 'g'), '');
}
