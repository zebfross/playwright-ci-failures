# Playwright CI Failures

A VS Code extension to browse Playwright e2e failures straight from your GitHub
Actions runs — the **error**, the **failed screenshot**, and the **video** — without
downloading and unzipping artifacts by hand.

## What it does

- Lists recent workflow runs for the repo you have open (auto-detected from the
  `origin` git remote).
- Pick a run → it downloads that run's Playwright artifacts in the background and
  shows every failure with its error message, screenshot, and video inline.
- Filter the failures with the search box (`/` or `⌘F` to focus, `Esc` to
  clear) — matches title, file, project, and env.
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

If a run deploys to several environments (e.g. `…-dev` runs the full suite and
`…-prod` runs only a smoke subset), upload a `playwright-json-<env>` +
`playwright-test-results-<env>` pair per environment. The extension downloads
**every** pair, merges the results, and tags each one with its `<env>` label.
Re-run duplicates are de-duped (newest wins).

## Develop / run it

```bash
npm install
npm run compile        # or: npm run watch
```

Then press **F5** in VS Code to launch an Extension Development Host, open a repo
that has Playwright CI, and run **"Playwright CI: Show CI Failures"** from the
Command Palette.

## Package, install & publish

All commands are npm scripts (no global installs needed):

```bash
npm run package         # build the .vsix (playwright-ci-failures-X.Y.Z.vsix)
npm run install:local   # package + install into your local VS Code (--force)
npm run publish         # publish current version to the Marketplace (needs auth)
```

**Update your local install** after changes: `npm run install:local`, then reload
VS Code. Or share the `.vsix` (Extensions panel → ⋯ → "Install from VSIX…").

**Publish manually:** `vsce login zebfross` once (or set `VSCE_PAT` env), then
`npm run publish`.

**Auto-publish (CI):** add a repo secret **`VSCE_PAT`** (Azure DevOps PAT with
*Marketplace → Manage* scope), then release with:

```bash
npm version patch        # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # pushing the tag triggers .github/workflows/release.yml
```

The workflow publishes to the Marketplace and attaches the `.vsix` to a GitHub
release. Once published, installed copies **auto-update** from the Marketplace.

## Settings

- `pwci.repo` — `owner/repo` override (default: detect from the git remote).
- `pwci.workflow` — workflow file name (e.g. `deploy.yml`) to filter runs by.

## Roadmap

- Side-by-side **compare** of two runs / two failures.
- Per-test **history** across runs to spot flaky vs. consistent failures.
