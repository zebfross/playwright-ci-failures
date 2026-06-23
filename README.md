# Playwright CI Failures

A VS Code extension to browse Playwright e2e failures straight from your GitHub
Actions runs — the **error**, the **failed screenshot**, and the **video** — without
downloading and unzipping artifacts by hand.

## What it does

- Lists recent workflow runs for the repo you have open (auto-detected from the
  `origin` git remote).
- Pick a run → it downloads that run's Playwright artifacts in the background and
  shows every failure with its error message, screenshot, and video inline.
- "Open trace" launches the Playwright Trace Viewer (`npx playwright show-trace`).
- Uses VS Code's built-in **GitHub sign-in** — no token or `gh` CLI to configure.

## Requirements on the CI side

The extension reads two artifacts that your e2e job should upload:

- `playwright-json-*` — the Playwright **JSON reporter** output
  (`['json', { outputFile: 'playwright-results.json' }]`). This carries the error
  text + attachment paths. Without it the extension falls back to whatever media
  it can find (screenshot/video) but won't have the error message.
- `playwright-test-results-*` — the `test-results/` directory (screenshots, videos,
  traces). Upload it with `if: always()`.

## Develop / run it

```bash
npm install
npm run compile        # or: npm run watch
```

Then press **F5** in VS Code to launch an Extension Development Host, open a repo
that has Playwright CI, and run **"Playwright CI: Show CI Failures"** from the
Command Palette.

## Package / share

```bash
npm install -g @vscode/vsce
vsce package           # produces playwright-ci-failures-0.1.0.vsix
```

Share the `.vsix` (Extensions panel → ⋯ → "Install from VSIX…") or publish it to
the Marketplace.

## Settings

- `pwci.repo` — `owner/repo` override (default: detect from the git remote).
- `pwci.workflow` — workflow file name (e.g. `deploy.yml`) to filter runs by.

## Roadmap

- Side-by-side **compare** of two runs / two failures.
- Per-test **history** across runs to spot flaky vs. consistent failures.
