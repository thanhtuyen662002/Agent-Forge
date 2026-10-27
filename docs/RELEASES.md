# Releases and in-app updates

Agent Forge has two release paths.

| Channel | How it is published | Version | Who decides |
| --- | --- | --- | --- |
| **Dev channel** | Automatically, by `.github/workflows/dev-channel.yml`, after every green `main` CI run | `0.1.<run>` (GitHub pre-release `v0.1.<run>`) | Repository policy, set by the owner on 2026-10-27 (#298) |
| **Stable** | Manually, by `.github/workflows/release-windows.yml` (`workflow_dispatch`), as a draft the owner publishes | `X.Y.Z` from `package.json` | The owner only |

Both channels are **unsigned** Windows NSIS installers until code signing is
set up, and Windows SmartScreen may warn on a first install.

## Dev channel (#298)

The workflow publishes only when all of the following hold:

- the `AgentForge CI` run succeeded;
- that run came from a `push` to `main` in this repository, never from a pull request or a fork;
- the commit it tested is still the current head of `main`. Otherwise the newer commit's CI run publishes instead.

It checks out the **exact tested commit** and stamps the version
`0.1.<workflow run number>`. The stamp exists only in CI; `package.json` is
never committed with it. It then builds the app, and electron-builder
publishes the installer, its blockmap and `latest.yml` as a GitHub pre-release.
The release notes give the commit subject and its SHA. The token has
`contents: write` in that job only, and the app embeds no secret: the
repository is public, so the feed needs no credentials.

## In-app updates

The installed app uses electron-updater against this repository's releases,
including pre-releases. Updating works like this:

- **Checking:** the app checks 30 seconds after it starts and every 4 hours.
  A check never discards an update it has already found or downloaded.
- **The header:** when a newer build exists, the header shows **Cập nhật lên
  x.y.z / Update to x.y.z**. One click downloads it. As soon as no work is
  running, the app restarts into the new version, keeping data and settings.
- **While work is running:** the notice says it is waiting. Pausing the
  project lets the update install right away.
- **Running work** means a task in `CODING`, `VALIDATING`, `DISPATCHED` or
  `REVIEWING` in a `RUNNING` project, or a coder run still in flight in any
  project. A paused or trashed project with a task left in `CODING` does not
  block updates.
- **Settings → Updates** keeps the same check, download and install controls.

Nothing is downloaded or installed without the owner's click.

## Moving off a manually installed build

Builds installed by hand before #298 are version `0.1.0` and do not look at
pre-releases. Install the first dev-channel build once by hand. Every later
build arrives in the app.
