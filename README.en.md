# DSH Intelligent UI

English · [中文](README.md)

Turn DeepSeek Harness chat results into interactive calculators, charts, maps, diagrams and small applications. UI documents persist in conversations and support history replay and single-file HTML export.

Version **1.2.1** targets the **Web client of the DeepSeek Harness `0.2.1-alpha.4` source distribution**. This is an independent plugin, not an official DeepSeek or OpenAI product. Other versions, including rc.2, require compatibility work and verification.

## Features

- Separate HTML/CSS/JavaScript generation, static streaming previews, and one-time activation after successful tool completion. DOM, SVG and Canvas can power interactive simulations and games.
- Persistent conversation nodes, saved-document replay, reset, automatic height and browser runtime error feedback.
- DSH light/dark themes, font settings and six templates: calculator, comparison, flowchart, line chart, bar chart and pie chart.
- Bundled Chart.js 4.5.1, structured text tables, and controlled bar/pie charts with offline replay.
- DSH Host place-name lookup and attributed Wikipedia/Commons photos, with up to four saved images per document. Leaflet 1.9.4, saved street regions, markers and itinerary playback.
- Current-model presentation routing, confirmed follow-ups, separate queue/model-run statuses, DSH human questions for meeting-time selection and read-only workflow snapshots.
- A standalone stdio MCP server with 13 resources, 3 prompts and 7 tools. It returns assembled HTML; rendering depends on the MCP client.

## Requirements and installation

- Node.js **22.19+**; this preparation was verified with Node 24.
- An installed and built [DeepSeek Harness source checkout](https://github.com/deepseek-ai/deepseek-harness) whose `package.json` version is `0.2.1-alpha.4`. Follow that checkout's instructions for `pnpm install` and `pnpm run build`. The latest default branch may be incompatible.
- PowerShell 7 for the DSH launcher helper. Building and static previews use Node.js directly.

Run from this project directory:

```powershell
# Replace with your actual, already-built DSH checkout.
$env:DSH_SOURCE = 'D:\code\deepseek-harness'
npm ci
npm run build
npm run check
```

On macOS/Linux, use `export DSH_SOURCE=/path/to/deepseek-harness`. Without this variable, the build searches for `deepseek-harness` next to this directory or one directory higher.

Regular dependencies are installed from this project's lockfile. Build scripts link only DSH-owned packages from the specified checkout, using Windows junctions or POSIX symlinks. They do not copy DSH or install global packages. `.npmrc` sets `legacy-peer-deps=true` so npm does not try to obtain host-only peer packages from a registry.

### Static preview

```sh
npm run preview
# Build and print the preview location without opening a browser:
npm run preview -- --no-open
```

No model is called. Preview follow-ups are recorded locally and do not reach a live conversation.

### Run inside DSH

```powershell
pwsh -NoProfile -File scripts/run-dsh.ps1 -Harness $env:DSH_SOURCE
```

The default port is `3098`; use `-Port 3099` if it is occupied. `-Check` checks configuration and `-NoOpen` suppresses browser opening. The helper generates `preview/local.patch.yml` and creates a dedicated `intelligent-ui` profile. Unless `DSH_HOME` is already set, it uses the Git-ignored `artifacts/dsh-home` directory.

Configure your model provider in DSH settings. Access tokens, API keys, sessions and proxy settings are local data. If image/map downloads need a proxy, copy `preview/images-network.example.yml` to the ignored `preview/images-network.patch.yml`, configure it locally and pass its path with `-ImageNetworkPatch`.

Example prompts:

```text
Create an interactive pendulum simulation with adjustable length and gravity, start/pause/reset controls, the period formula, units and ideal-model assumptions.
```

```text
Create an interactive itinerary for the Forbidden City, Temple of Heaven and Summer Palace in Beijing. Resolve place names automatically, include a relevant photo for each stop, add playback and link sources from the descriptions.
```

```text
Create a retro interactive gaming console that I can play.
```

Generated games and scientific simulations still need hands-on validation. An interactive runtime does not guarantee that every model-generated program is correct.

## Standalone MCP

```sh
npm run build
npm run verify:mcp
npm run mcp
```

The build generates a machine-specific `preview/mcp.config.json` for a stdio-capable MCP client. It contains absolute local paths and is intentionally ignored by Git.

For portable execution, copy the entire generated `dist/mcp` directory to another machine, run `npm install --ignore-scripts` there, then `node mcp-stdio.js`. Running that package does not require DSH, React or a browser server. Building it still requires the development environment above. Map preparation may access fixed upstream sources; standalone MCP does not provide DSH's place lookup, photo retrieval or confirmed chat bridge.

## Development and tests

```sh
npm run build
npm run check
# Existing Edge is selected automatically on Windows; otherwise install Chromium:
npx playwright install chromium
npm test
npm run verify:mcp
npm run audit:release
```

Alternatively set `DSH_TEST_BROWSER` to an installed Chromium-family browser executable. Tests use the built DSH modules for integration checks and write ignored `artifacts/`; they do not send live model messages. An optional real-photo replay check reads a prepared v3 document JSON from `DSH_LIVE_IMAGE_FIXTURE`. Without it, only that check is skipped; deterministic image tests still run.

See [architecture](docs/architecture.md), [runtime API](docs/runtime.md) and [development notes](docs/development.md).

## Data, networking and limits

Generated code runs in an opaque-origin iframe with CSP and a validated message bridge. Follow-ups and external links require host confirmation. HTML fragments cannot load remote scripts, arbitrary iframes or arbitrary network requests. The Host retrieves controlled images and default street data; saved documents replay offline, but initial retrieval needs a network connection. Street coverage is limited to the saved region. Legacy NASA/USGS modes may request fixed-origin remote tiles.

Meeting selection does not book a meeting. Workflow snapshots do not advance native tasks. Exported standalone HTML does not include a live chat service.

## Publication and licensing

The repository contains source, automated tests, essential documentation, the dependency lockfile and third-party resource licenses. Local acceptance reports, historical comparisons, personal TODOs, screenshots, model outputs, sessions, logs and machine configuration are excluded. Build and test output is covered by `.gitignore`.

This project is licensed under the [MIT License](LICENSE). Third-party resources retain their own licenses: see [third-party notices](THIRD_PARTY_NOTICES.md), `vendor/`, and the map fixture's [attribution](tests/fixtures/MAP-DATA-NOTICE.md).
