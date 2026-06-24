import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as gh from './github';

export function activate(context: vscode.ExtensionContext) {
    const runsProvider = new RunsProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('pwciRuns', runsProvider),
        vscode.commands.registerCommand('pwci.show', () => Panel.show(context)),
        vscode.commands.registerCommand('pwci.refreshRuns', () => runsProvider.refresh()),
        vscode.commands.registerCommand('pwci.openRun', (runId: number) => Panel.openRun(context, runId)),
    );
}

export function deactivate() {
    /* nothing to clean up */
}

/** The Source Control sidebar tree that lists recent workflow runs. */
class RunsProvider implements vscode.TreeDataProvider<gh.Run> {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    refresh(): void {
        this._onDidChange.fire();
    }

    getTreeItem(run: gh.Run): vscode.TreeItem {
        const item = new vscode.TreeItem(run.display_title || run.name);
        const concl = run.status !== 'completed' ? run.status : run.conclusion || '—';
        item.description = `#${run.run_number} · ${run.head_branch} · ${concl}`;
        item.tooltip = `${run.name}\n${concl} · ${run.head_branch}\n${run.created_at}`;
        item.iconPath = iconFor(run);
        item.command = { command: 'pwci.openRun', title: 'Open run', arguments: [run.id] };
        return item;
    }

    async getChildren(element?: gh.Run): Promise<gh.Run[]> {
        if (element) {
            return [];
        }
        const repo = gh.detectRepo();
        if (!repo) {
            return [];
        }
        // Silent token — don't pop a sign-in prompt just for opening the sidebar.
        const token = await gh.getToken(false);
        if (!token) {
            return [];
        }
        try {
            return await gh.listRuns(token, repo.owner, repo.repo);
        } catch {
            return [];
        }
    }
}

function iconFor(run: gh.Run): vscode.ThemeIcon {
    if (run.status !== 'completed') {
        return new vscode.ThemeIcon('sync~spin');
    }
    if (run.conclusion === 'success') {
        return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    }
    if (run.conclusion === 'failure') {
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    }
    return new vscode.ThemeIcon('circle-outline');
}

class Panel {
    private static current: Panel | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private ready = false;
    private pendingRunId?: number;

    static show(context: vscode.ExtensionContext) {
        if (Panel.current) {
            Panel.current.panel.reveal();
            return;
        }
        const workRoot = path.join(context.globalStorageUri.fsPath, 'runs');
        fs.mkdirSync(workRoot, { recursive: true });

        const panel = vscode.window.createWebviewPanel(
            'pwciFailures',
            'Playwright CI Failures',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.file(workRoot),
                ],
            },
        );
        Panel.current = new Panel(panel, context, workRoot);
    }

    /** Open (or focus) the panel and navigate it to a specific run. */
    static openRun(context: vscode.ExtensionContext, runId: number) {
        Panel.show(context);
        Panel.current?.requestRun(runId);
    }

    private requestRun(runId: number) {
        this.panel.reveal();
        if (this.ready) {
            this.post({ type: 'openRunExternal', runId });
        } else {
            // Webview not loaded yet — flush once it signals 'ready'.
            this.pendingRunId = runId;
        }
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly workRoot: string,
    ) {
        this.panel.webview.html = this.html();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);

        // Dev convenience: hot-reload the webview whenever media/ changes, so
        // UI tweaks (main.js / main.css) show up on save without Cmd+R.
        if (this.context.extensionMode === vscode.ExtensionMode.Development) {
            const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media').fsPath;
            let timer: NodeJS.Timeout | undefined;
            const watcher = fs.watch(mediaPath, () => {
                if (timer) {
                    clearTimeout(timer);
                }
                timer = setTimeout(() => {
                    this.panel.webview.html = this.html();
                }, 100);
            });
            this.disposables.push(new vscode.Disposable(() => watcher.close()));
        }
    }

    private async onMessage(m: any) {
        try {
            if (m.type === 'ready') {
                this.ready = true;
                await this.loadRuns();
                if (this.pendingRunId !== undefined) {
                    this.post({ type: 'openRunExternal', runId: this.pendingRunId });
                    this.pendingRunId = undefined;
                }
            } else if (m.type === 'openRun') {
                await this.loadFailures(m.runId, !!m.force);
            } else if (m.type === 'openTrace') {
                this.openTrace(m.path);
            } else if (m.type === 'openFile' && m.path) {
                // Open the webm/png in the OS default app (browser/player) —
                // the webview can't always decode webm inline.
                await vscode.env.openExternal(vscode.Uri.file(m.path));
            } else if (m.type === 'openUrl' && m.url) {
                await vscode.env.openExternal(vscode.Uri.parse(m.url));
            } else if (m.type === 'clearCache') {
                gh.clearFailuresCache();
                fs.rmSync(this.workRoot, { recursive: true, force: true });
                fs.mkdirSync(this.workRoot, { recursive: true });
                await this.loadRuns();
            }
        } catch (e: any) {
            this.post({ type: 'error', message: e?.message ?? String(e) });
        }
    }

    private async loadRuns() {
        const repo = gh.detectRepo();
        if (!repo) {
            this.post({
                type: 'error',
                message:
                    'No GitHub repo detected from the workspace git remote. Set "pwci.repo" (owner/repo) in settings.',
            });
            return;
        }
        this.post({ type: 'status', message: `Loading runs for ${repo.owner}/${repo.repo}…` });
        const token = await gh.getToken();
        if (!token) {
            this.post({ type: 'error', message: 'GitHub sign-in is required.' });
            return;
        }
        const runs = await gh.listRuns(token, repo.owner, repo.repo);
        this.post({
            type: 'runs',
            repo: `${repo.owner}/${repo.repo}`,
            runs,
            dev: this.context.extensionMode === vscode.ExtensionMode.Development,
        });
        // Keep the sidebar tree in sync (e.g. populate it after the first sign-in).
        void vscode.commands.executeCommand('pwci.refreshRuns');
    }

    private async loadFailures(runId: number, force = false) {
        const repo = gh.detectRepo();
        if (!repo) {
            return;
        }
        const token = await gh.getToken();
        if (!token) {
            return;
        }
        const failures = await gh.getRunFailures(token, repo.owner, repo.repo, runId, this.workRoot, force);
        const mapped = failures.map((f) => ({
            ...f,
            screenshot: this.uri(f.screenshot),
            video: this.uri(f.video),
            // keep fs paths too so the webview can open them externally
            videoFile: f.video,
            screenshotFile: f.screenshot,
            // trace stays an fs path — opened via `npx playwright show-trace`
        }));
        this.post({ type: 'failures', runId, failures: mapped });
    }

    private uri(p?: string): string | undefined {
        return p ? this.panel.webview.asWebviewUri(vscode.Uri.file(p)).toString() : undefined;
    }

    private openTrace(tracePath?: string) {
        if (!tracePath) {
            return;
        }
        const term = vscode.window.createTerminal('Playwright trace');
        term.show();
        term.sendText(`npx playwright show-trace ${JSON.stringify(tracePath)}`);
    }

    private post(msg: unknown) {
        void this.panel.webview.postMessage(msg);
    }

    private html(): string {
        const w = this.panel.webview;
        // ?v= busts the webview's resource cache so hot-reload picks up edits.
        const ver = Date.now();
        const css = `${w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'))}?v=${ver}`;
        const js = `${w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'))}?v=${ver}`;
        const nonce = String(Math.floor((Date.now() % 1e9) + 1)) + 'abc';
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; media-src ${w.cspSource}; style-src ${w.cspSource}; script-src 'nonce-${nonce}';" />
<link href="${css}" rel="stylesheet" />
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }

    private dispose() {
        Panel.current = undefined;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
        this.panel.dispose();
    }
}
