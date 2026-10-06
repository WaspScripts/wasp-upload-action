# wasp-upload-action

GitHub Action that compile tests Simba scripts with the latest Simba and WaspLib and uploads the
ones that compile to waspscripts.com.

## Repository layout

Every top level folder with a `.simba` file in it is a script:

```
my-scripts/
├── scripts.json
├── my-script/
│   ├── my-script.simba   <- main file
│   ├── helper.simba
│   └── data.json
└── another-script/
    └── main.simba
```

`scripts.json` maps the script folders to their waspscripts.com IDs:

```json
{
	"my-script": { "id": "d367e87f-da39-46ac-89df-f5b80f79d8a5" },
	"another-script": { "id": "7b173a61-b3a0-4010-ac77-16e36645387d", "main": "main.simba" }
}
```

- `main` is optional. By default it's `<folder>.simba`, or the only `.simba` file in the folder.
- Scripts without an ID are only compile tested.
- Only the file types waspscripts.com accepts are uploaded. `banner.webp` and `cover.webp` are
  the website images and are skipped, other `banner.*`/`cover.*` files are uploaded.
  Subfolders are not uploaded.
- Like on the website, the main file is uploaded as `script.simba`.

## What it does

1. Picks the scripts to process. By default these are the scripts with files or `scripts.json`
   entries changed by the push or pull request.
2. Installs the latest Simba, WaspLib and wasp-plugins the same way wasp-launcher does.
3. Compiles every script exactly as it will be uploaded.
4. Uploads the scripts that compiled as a new revision, recording the Simba and WaspLib versions
   they were tested with.
5. Optionally announces the uploaded scripts on Discord with their name, link, revision and the
   commits that changed them. Unpublished scripts are not announced.

Scripts that fail to compile are not uploaded. Compile errors are shown as annotations on the files
and the job fails, but the other scripts are still uploaded.

## Usage

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: scripts-${{ github.event_name == 'pull_request' && github.ref || 'upload' }}

jobs:
  scripts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # needed to find which scripts changed
      - uses: WaspScripts/wasp-upload-action@v1
        with:
          SB_URL: ${{ secrets.SUPABASE_URL }}
          SB_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
          EMAIL: ${{ secrets.EMAIL }}
          PASSWORD: ${{ secrets.PASSWORD }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
          DRY_RUN: ${{ github.event_name == 'pull_request' }}
```

## Inputs

| Input             | Default        | Description                                                         |
| ----------------- | -------------- | ------------------------------------------------------------------- |
| `SB_URL`          |                | Supabase URL.                                                       |
| `SB_ANON_KEY`     |                | Supabase anon key.                                                  |
| `EMAIL`           |                | waspscripts.com account email. Not needed with `DRY_RUN`.           |
| `PASSWORD`        |                | waspscripts.com account password. Not needed with `DRY_RUN`.        |
| `PATH`            | `.`            | Folder with the scripts, relative to the repository root.           |
| `MANIFEST`        | `scripts.json` | Manifest file inside `PATH`.                                        |
| `SCRIPTS`         | `changed`      | `changed`, `all` or a space/comma separated list of script folders. |
| `DRY_RUN`         | `false`        | Only compile test, don't upload.                                    |
| `DISCORD_WEBHOOK` |                | Discord webhook URL to announce uploaded scripts on.                |
| `SIMBA_VERSION`   | `latest`       | Simba version to compile with.                                      |
| `WASPLIB_VERSION` | `latest`       | WaspLib version to compile with.                                    |

## Development

```sh
pnpm install
pnpm run all # builds lib/ and bundles it into dist/, which has to be committed
```
