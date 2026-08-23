# Lumina Terminal — Update System

Lumina Terminal ships with a built-in auto-updater ([Tauri v2 updater plugin][updater]).
This document describes how it works, how to configure signing, and how to
publish a release that users can update to.

---

## How it works (at a glance)

1. On startup, the app checks `endpoints` from `src-tauri/tauri.conf.json`
   (`plugins.updater`) — a `latest.json` manifest hosted on the GitHub Release.
   This only runs if the user has **Auto-check for updates on startup** enabled
   (default: on, toggleable in Settings → General).
2. The user can also check manually from **About → Updates → Check for Updates**.
3. When an update is found, the About page shows the new version and an
   **Install and Restart** button. Downloading + installing is always explicit
   (never silent) so it never interrupts a running terminal session.
4. The downloaded bundle is verified against the **public key** in
   `tauri.conf.json` before install. A mismatch is rejected.

---

## Signing keys (REQUIRED)

The updater verifies update bundles with an Ed25519 keypair:

- **Public key** — embedded in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`. This ships with the app and is public.
- **Private key (+ password)** — used by CI to sign release bundles. This is
  **secret** and must live in GitHub repository Secrets, never in the repo.

### Generating a new keypair

```bash
pnpm tauri signer generate -w lumina-updater.key
# (omit -w to print to stdout without writing a file)
```

This prints two blocks:

- `Private: ...` → goes into the GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`
- `Public: ...` → goes into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`

> ⚠️ If you lose the private key (or its password), **you cannot ship updates
> that existing installs will accept.** Back it up somewhere durable.

### Configuring GitHub Secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name | Value |
|-------------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | the full private key string |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you set (or empty) |

The release workflow (`.github/workflows/release.yml`) passes these into
`tauri-apps/tauri-action`, which signs the bundles and emits `latest.json`.

---

## Publishing a release

1. Bump the version (keeps `package.json`, `Cargo.toml`, `tauri.conf.json` in sync):
   ```bash
   ./scripts/bump-version.sh 0.2.0
   ```
2. Commit, tag, and push:
   ```bash
   git commit -am "update: v0.2.0"
   git tag v0.2.0
   git push origin master v0.2.0
   ```
3. Create a GitHub Release from the tag (or publish a draft). On publish, the
   **Release** workflow builds all four targets, signs them, uploads installers
   + `.sig` files + `latest.json` to the release assets.
4. Existing installs pick up the new `latest.json` on their next check and offer
   the update.

### What `latest.json` is

The Tauri v2 manifest the app fetches at
`https://github.com/iewnfod/lumina-terminal/releases/latest/download/latest.json`.
`tauri-action` generates and uploads it automatically; do not edit it by hand.

---

## Config reference (`tauri.conf.json`)

```jsonc
"bundle": {
  "createUpdaterArtifacts": true   // emit .sig + .tar.gz/.nsis on build
},
"plugins": {
  "updater": {
    "pubkey": "<base64 public key>",
    "endpoints": [
      "https://github.com/iewnfod/lumina-terminal/releases/latest/download/latest.json"
    ]
  }
}
```

Permissions (`src-tauri/capabilities/default.json`): `updater:default`,
`process:default` (the latter for relaunching after install).

---

## Frontend code map

| File | Role |
|------|------|
| `src/lib/updater.ts` | Pure wrapper over `@tauri-apps/plugin-updater` / `plugin-process` (check / download+install / relaunch) |
| `src/lib/updateAvailable.ts` | Module-level cache of the startup check result |
| `src/hooks/useUpdater.ts` | React state machine for the About page (status / progress / install) |
| `src/hooks/useStartupUpdateCheck.ts` | One-shot check on startup, gated by the `autoUpdateOnStartup` setting |
| `src/pages/AboutPage.tsx` | Update UI (check button, progress, install, release notes) |
| `src/components/settings/GeneralSettings.tsx` | Auto-check toggle |

[updater]: https://v2.tauri.app/plugin/updater/
