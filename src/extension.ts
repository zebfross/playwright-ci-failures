import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as gh from './github';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('pwci.show', () => Panel.show(context)),
    );
}

export function deactivate() {
    /* nothing to clean up */
}

class Panel {
    private static current: Panel | undefined;
    private readonly disposables: vscode.Disposable[] = [];

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

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly workRoot: string,
    ) {
        this.panel.webview.html = this.html();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    }

    private async onMessage(m: any) {
        try {
            if (m.type === 'ready') {
                await this.loadRuns();
            } else if (m.type === 'openRun') {
                await this.loadFailures(m.runId, !!m.force);
            } else if (m.type === 'openTrace') {
                this.openTrace(m.path);
            } else if (m.type === 'openUrl' && m.url) {
                vscode.env.openExternal(vscode.Uri.parse(m.url));
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
        const runs = await gh.listRuns(token, repo.owner, repo.repo);
        this.post({ type: 'runs', repo: `${repo.owner}/${repo.repo}`, runs });
    }

    private async loadFailures(runId: number, force = false) {
        const repo = gh.detectRepo();
        if (!repo) {
            return;
        }
        this.post({ type: 'loadingRun', runId });
        const token = await gh.getToken();
        const failures = await gh.getRunFailures(token, repo.owner, repo.repo, runId, this.workRoot, force);
        const mapped = failures.map((f) => ({
            ...f,
            screenshot: this.uri(f.screenshot),
            video: this.uri(f.video),
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
        const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
        const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
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
