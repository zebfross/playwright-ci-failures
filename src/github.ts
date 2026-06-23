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
    file: string;
    title: string;
    project: string;
    status: string;
    error: string;
    screenshot?: string; // local fs path (mapped to a webview uri by the panel)
    video?: string;
    trace?: string;
}

export async function getToken(): Promise<string> {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    return session.accessToken;
}

export function detectRepo(): { owner: string; repo: string } | undefined {
    const override = vscode.workspace.getConfiguration('pwci').get<string>('repo');
    if (override && override.includes('/')) {
        const [owner, repo] = override.split('/');
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
    new AdmZip(buf).extractAllTo(destDir, true);
}

export async function getRunFailures(
    token: string,
    owner: string,
    repo: string,
    runId: number,
    workRoot: string,
): Promise<Failure[]> {
    const { artifacts } = await api<{ artifacts: Artifact[] }>(
        token,
        `${API}/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
    );
    const jsonArt = artifacts.find((a) => /playwright-json/i.test(a.name));
    const mediaArt = artifacts.find((a) => /playwright-test-results/i.test(a.name));

    const runDir = path.join(workRoot, `run-${runId}`);
    fs.rmSync(runDir, { recursive: true, force: true });
    const jsonDir = path.join(runDir, 'json');
    const mediaDir = path.join(runDir, 'media');
    fs.mkdirSync(jsonDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    if (mediaArt) {
        await downloadArtifact(token, owner, repo, mediaArt.id, mediaDir);
    }

    if (jsonArt) {
        await downloadArtifact(token, owner, repo, jsonArt.id, jsonDir);
        const jsonPath = findFile(jsonDir, (f) => f.endsWith('.json'));
        if (jsonPath) {
            return failuresFromReport(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), mediaDir);
        }
    }
    // Older run (before the JSON reporter) — surface whatever media exists.
    return failuresFromMedia(mediaDir);
}

function failuresFromReport(report: any, mediaDir: string): Failure[] {
    const out: Failure[] = [];
    const visitFile = (fileSuite: any) => {
        const file: string = fileSuite.title ?? '';
        const walk = (suite: any, prefix: string[]) => {
            for (const spec of suite.specs ?? []) {
                for (const test of spec.tests ?? []) {
                    const result = (test.results ?? []).slice(-1)[0];
                    if (!result || result.status === 'passed' || result.status === 'skipped') {
                        continue;
                    }
                    const atts = result.attachments ?? [];
                    out.push({
                        file,
                        title: [...prefix, spec.title].filter(Boolean).join(' › '),
                        project: test.projectName ?? '',
                        status: result.status,
                        error: stripAnsi(
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

function failuresFromMedia(mediaDir: string): Failure[] {
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
        out.push({
            file: '',
            title: dir,
            project: '',
            status: 'failed',
            error: ctx
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
