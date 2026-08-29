# Windows App Release Tooling

This directory publishes only the Moonshine Image application installer. Model weights and
SAM assets remain on their existing model distribution channels.

## Requirements

- Node.js 20 or newer (the workflow uses Node.js 22).
- An electron-builder output directory containing `latest.yml`, the versioned NSIS `.exe`,
  and its `.exe.blockmap` file.
- A local FFmpeg distribution containing `ffmpeg.exe` and `ffprobe.exe` (set
  `MOONSHINE_FFMPEG_ROOT` when it is outside `build-resources/ffmpeg`); the resource preparation
  step fails closed rather than producing an installer without FFmpeg.
- R2 credentials with object read/write permission for
  `moonshine-image-app-release-prod`.

The scripts never call bucket-listing APIs. Every R2 request uses a deterministic object key.

## Configuration

Configuration can come from environment variables or a `KEY=VALUE` file passed with
`--config-file`. Environment variables override file values.

```text
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
R2_BUCKET=moonshine-image-app-release-prod
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_REGION=auto
R2_PUBLIC_BASE_URL=https://download.moonshine.email
R2_RELEASE_PREFIX=app/win-x64
```

`R2_ENDPOINT` may be omitted when `R2_ACCOUNT_ID` is present. Reports contain only public
URLs, object keys, sizes, and hashes; credentials are never included.

Runtime and model weights are not R2 release objects. The light NSIS package creates a managed
Python environment locally; the full offline packages carry the prepared environment as a
sibling payload next to the NSIS installer. Model management continues to use the existing
Hugging Face and Quark links.

Build each offline package from a prepared payload directory. The payload is never uploaded to
R2 and is not part of the electron-updater feed:

```powershell
$env:MOONSHINE_RUNTIME_FLAVOR = "cpu"
$env:MOONSHINE_MODEL_BUNDLE = "external-models"
$env:MOONSHINE_RUNTIME_ENV_NAME = "moonshine-runtime-312-cpu"
$env:MOONSHINE_RUNTIME_OUTPUT_DIR = "C:\release\prepared\runtime-cpu\win-x64"
npm run build:runtime:win

$env:MOONSHINE_RUNTIME_FLAVOR = "cu130"
$env:MOONSHINE_MODEL_BUNDLE = "external-models"
$env:MOONSHINE_RUNTIME_ENV_NAME = "moonshine-runtime-312-cu130"
$env:MOONSHINE_RUNTIME_OUTPUT_DIR = "C:\release\prepared\runtime-cu130\win-x64"
npm run build:runtime:win
```

Both named Conda environments must already exist or be buildable by `build-runtime-win.mjs`.
`MOONSHINE_RUNTIME_OUTPUT_DIR` changes only the materialized runtime destination; the normal
Electron resource preparation keeps its existing default path.

```powershell
npm run build:offline:bundle:win -- `
  --version 1.3.0 `
  --variant cpu `
  --installer C:\release\Moonshine-Image-Setup-1.3.0.exe `
  --payload-root C:\release\offline-payload\cpu `
  --private-key-file C:\private\release-manifest-private.pem
```

The command writes `Moonshine-Image-v1.3.0-win-x64-cpu-offline.zip` plus a local JSON report.
The ZIP contains the NSIS installer and `offline-payload/payload-manifest.json`; the manifest is
Ed25519 signed in production and every payload file is SHA-256 hashed. Use `--allow-unsigned`
only for local diagnostics.

Public HTTP checks use a five-minute timeout per request by default. Override it with
`--request-timeout-ms <milliseconds>` when testing a slower route or a deliberately short
failure boundary.

## Object Layout

For version `1.3.0`, the immutable phase writes the selected channel path (the example uses
`beta`):

```text
app/win-x64/beta/Moonshine-Image-Setup-1.3.0.exe
app/win-x64/beta/Moonshine-Image-Setup-1.3.0.exe.blockmap
app/win-x64/manifests/1.3.0/latest.yml
manifests/1.3.0/beta/latest.json
```

The separately approved channel phase writes only the mutable pointers:

```text
app/win-x64/<channel>/latest.yml
manifests/<channel>/latest.json
```

Versioned assets and archived manifests use an immutable one-year cache policy. The stable
manifest uses `no-cache, no-store, must-revalidate`.

## Local Commands

For app-only CUDA builds, the resource preparation step removes `sam3` from the CUDA lock
transaction and places one controlled local wheel under `resources/sam3`. It first uses
`MOONSHINE_SAM3_WHEEL`, then an existing `build-resources/.tmp/runtime/sam3-wheel` output, and
finally builds `third_party/sam3` with the selected Python. The application installs that wheel
after the base requirements with `pip --no-deps --force-reinstall`; CPU builds omit the resource.

```powershell
$env:MOONSHINE_RUNTIME_FLAVOR = "cu130"
# Optional when a pre-built wheel is available:
$env:MOONSHINE_SAM3_WHEEL = "C:\release\sam3-0.1.0-py3-none-any.whl"
npm.cmd run build:electron:installer
```

If the workstation's NSIS cache is missing `StdUtils::TestParameter`, use the repository's
isolated local compiler path: `npm.cmd run build:electron:installer:local`.

Validate local output and show the exact upload plan without credentials or network writes:

```powershell
npm run release:app:audit -- --artifact-dir dist/electron/Packaged --version 1.3.0
npm run release:app:upload -- --artifact-dir dist/electron/Packaged --version 1.3.0 --dry-run
```

The audit verifies the signed packaged-resource manifest, every backend and FFmpeg size/hash,
exact resource coverage, the absence of embedded runtime/model directories, and the installer
size/SHA-512 recorded in `latest.yml`. CI runs it before any upload step.

Upload immutable objects, then independently verify them through R2 and the public domain:

```powershell
npm run release:app:upload -- --artifact-dir dist/electron/Packaged --version 1.3.0 --channel beta --config-file C:\path\to\r2.env
npm run release:app:verify -- --scope immutable --channel beta --artifact-dir dist/electron/Packaged --version 1.3.0 --config-file C:\path\to\r2.env
```

After immutable verification, publish a test/beta pointer with an exact channel confirmation. The
same EXE bytes are copied under the channel-specific immutable path; no rebuild is required:

```powershell
npm run release:app:publish-channel -- --channel beta --artifact-dir dist/electron/Packaged --version 1.3.0 --app-manifest dist/electron/Packaged/app-manifest.json --confirm-channel beta:1.3.0 --config-file C:\path\to\r2.env
npm run release:app:verify -- --scope channel --channel beta --artifact-dir dist/electron/Packaged --version 1.3.0 --app-manifest dist/electron/Packaged/app-manifest.json --config-file C:\path\to\r2.env
```

After the canary window and manual approval, publish the stable pointer with its exact version
confirmation. Generate a stable-channel signed app manifest for this step; a beta-signed manifest
is intentionally rejected by the publisher.

```powershell
npm run release:app:publish-stable -- --artifact-dir dist/electron/Packaged --version 1.3.0 --confirm-stable 1.3.0 --config-file C:\path\to\r2.env
npm run release:app:verify -- --scope stable --artifact-dir dist/electron/Packaged --version 1.3.0 --config-file C:\path\to\r2.env
```

Each verification performs R2 `HeadObject` and `GetObject` checks plus public-domain HEAD,
byte-range, and full SHA-256 checks.

The release workflow never invokes component or model publication commands. Runtime, FFmpeg and
model payloads are either built into the optional offline ZIPs or prepared locally by the
installed application. The R2 upload job writes only the app installer, blockmap, `latest.yml`
and signed app manifest. Use `npm run build:offline:bundle:win` for each CPU/cu130 payload before
the release review; the resulting ZIP is a download-page artifact, not an R2 update object.

The initial `1.3.0` Windows build is intentionally unsigned and sets
`win.signAndEditExecutable` to `false`. This avoids loading the signing toolchain, but also
leaves Electron's default PE icon/version metadata in place. Re-enable the option when a
trusted Windows signing certificate is introduced.

## GitHub Actions Setup

Add these repository secrets:

```text
R2_ACCOUNT_ID
R2_ENDPOINT
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
MOONSHINE_MANIFEST_PUBLIC_KEY_PEM
MOONSHINE_MANIFEST_PRIVATE_KEY_PEM
```

Generate the independent Ed25519 release keypair once into an explicitly selected private
directory outside the repository. The command refuses to overwrite any existing key material and
does not print the private key:

```powershell
npm run release:manifest:key:generate -- --output-dir D:\private\moonshine-release-key-v1
```

Back up `release-manifest-private.pem` offline before adding its contents to the CI secret. Keep
`release-manifest-public.pem` and `release-manifest-key.json` with the release records; the JSON
fingerprint is the value to compare when reviewing key injection. On Windows, file modes are only
best-effort, so the selected directory must also have an appropriate NTFS ACL.

The public key is injected into the packaged client by
`npm run release:manifest:key:inject`; the private key is used only by the signing step and is
never written to the application. `npm run release:manifest:key:assert` fails closed when the
production public key is absent or is not Ed25519.

For an external Windows acceptance machine:

```powershell
scripts\validation\run-validation.cmd --source https://download.moonshine.email --mirror https://mirror.example --channel beta --public-key-file C:\path\release-public-key.pem --report C:\temp\moonshine-validation.json
Compress-Archive -Path C:\temp\moonshine-validation.json -DestinationPath C:\temp\moonshine-validation.zip -Force
```

The same validator is available through `npm run validate:release -- ...` and verifies the App
manifest, installer bytes, optional offline ZIP and optional managed environment for the selected
channel. In
`--mode source-failover`, a deliberately unavailable primary is accepted only when the mirror
passes manifest signature, byte parity, Range, size and hash checks. Other modes continue to
treat a primary outage as a failed/degraded release.

Create a GitHub Environment named `app-release-stable` and configure required reviewers.
Selecting the workflow's `publish_stable` input only requests the stable job; the protected
Environment remains the manual approval boundary.
