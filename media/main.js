// @ts-nocheck
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

let state = { repo: '', runs: [], view: 'loading', runId: null, failures: [], note: 'Loading…' };

window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
        case 'status':
            state.note = m.message;
            if (state.view !== 'runs') render();
            break;
        case 'error':
            state.view = 'error';
            state.note = m.message;
            render();
            break;
        case 'runs':
            state.repo = m.repo;
            state.runs = m.runs;
            state.view = 'runs';
            render();
            break;
        case 'loadingRun':
            state.view = 'loading';
            state.note = 'Downloading artifacts & parsing failures…';
            render();
            break;
        case 'failures':
            state.runId = m.runId;
            state.failures = m.failures;
            state.view = 'failures';
            render();
            break;
    }
});

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (v != null) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
}

function ago(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function conclusionClass(run) {
    if (run.status !== 'completed') return 'badge running';
    if (run.conclusion === 'success') return 'badge ok';
    if (run.conclusion === 'failure') return 'badge fail';
    return 'badge other';
}

function render() {
    app.replaceChildren();
    if (state.view === 'loading') {
        app.append(el('div', { class: 'center muted' }, state.note));
        return;
    }
    if (state.view === 'error') {
        app.append(el('div', { class: 'center error' }, state.note));
        app.append(el('div', { class: 'center' }, el('button', { onclick: () => vscode.postMessage({ type: 'ready' }) }, 'Retry')));
        return;
    }
    if (state.view === 'runs') return renderRuns();
    if (state.view === 'failures') return renderFailures();
}

function renderRuns() {
    app.append(
        el('div', { class: 'topbar' },
            el('strong', {}, state.repo),
            el('button', { class: 'ghost', onclick: () => vscode.postMessage({ type: 'ready' }) }, '⟳ Refresh'),
        ),
    );
    const list = el('div', { class: 'runs' });
    for (const run of state.runs) {
        list.append(
            el('div', { class: 'run', onclick: () => vscode.postMessage({ type: 'openRun', runId: run.id }) },
                el('span', { class: conclusionClass(run) }, run.status !== 'completed' ? run.status : (run.conclusion || '—')),
                el('div', { class: 'run-main' },
                    el('div', { class: 'run-title' }, run.display_title || run.name),
                    el('div', { class: 'run-sub muted' }, `${run.name} · #${run.run_number} · ${run.head_branch} · ${ago(run.created_at)}`),
                ),
                el('button', { class: 'ghost small', onclick: (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'openUrl', url: run.html_url }); } }, 'GitHub ↗'),
            ),
        );
    }
    app.append(list);
}

function renderFailures() {
    app.append(
        el('div', { class: 'topbar' },
            el('button', { class: 'ghost', onclick: () => vscode.postMessage({ type: 'ready' }) }, '← Runs'),
            el('strong', {}, `${state.failures.length} failure${state.failures.length === 1 ? '' : 's'} · run #${state.runId}`),
        ),
    );
    if (state.failures.length === 0) {
        app.append(el('div', { class: 'center muted' }, 'No failures found in this run’s artifacts. 🎉'));
        return;
    }
    const grid = el('div', { class: 'failures' });
    for (const f of state.failures) {
        const card = el('div', { class: 'card' });
        card.append(
            el('div', { class: 'card-head' },
                el('span', { class: 'badge fail' }, f.status),
                f.project ? el('span', { class: 'badge proj' }, f.project) : null,
                el('span', { class: 'card-title' }, f.title || '(untitled)'),
            ),
        );
        if (f.file) card.append(el('div', { class: 'muted file' }, f.file));
        if (f.error) card.append(el('pre', { class: 'err' }, f.error));
        const media = el('div', { class: 'media' });
        if (f.screenshot) media.append(el('img', { src: f.screenshot, loading: 'lazy' }));
        if (f.video) media.append(el('video', { src: f.video, controls: '', preload: 'metadata' }));
        if (f.screenshot || f.video) card.append(media);
        const actions = el('div', { class: 'actions' });
        if (f.trace) actions.append(el('button', { onclick: () => vscode.postMessage({ type: 'openTrace', path: f.trace }) }, '▶ Open trace'));
        card.append(actions);
        grid.append(card);
    }
    app.append(grid);
}

vscode.postMessage({ type: 'ready' });
render();
