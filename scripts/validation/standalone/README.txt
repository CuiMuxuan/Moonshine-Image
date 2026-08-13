Moonshine-Image Test Validator
==============================

1. Extract this entire validator ZIP to a normal folder.
2. Double-click Run-Moonshine-Image-Test-Validator.cmd.
3. If possible, keep Moonshine-Image-Test open so the validator can cross-check the
   effective Python environment, service process and local health endpoint.
4. Wait until the window reports completion. The normal double-click run uses
   lightweight metadata/range requests and does not download an installer,
   model or dependency package. The window continuously shows the current
   stage, check name, completed/failed count and elapsed time; long checks
   print a heartbeat every 10 seconds.
5. Send the generated Moonshine-Image-validation-*.zip from your Desktop to
   the Moonshine-Image developer.

The validator automatically:
- checks the signed test release manifest and application files;
- probes the release feed, Python installer, PyPI, PyTorch CPU/cu130, the
  Hugging Face site and an actual Moonshine model URL with small HTTP requests;
- detects the matching Moonshine-Image-Test NSIS installation, verifies the signed
  packaged-resource manifest, and checks every protected service/FFmpeg file;
- validates application configuration and managed or external environments;
- inventories Python interpreters from PATH, the Python Launcher, Conda,
  common install paths and the application's effective environment, then
  records each real version, source, executable path and 3.12.x compatibility;
- checks pinned Python packages, pip dependency consistency and service-module
  imports;
- detects NVIDIA hardware/driver state and, for cu130, performs an actual
  PyTorch CUDA tensor operation on device 0;
- cross-checks the application's effective runtime receipt, process state,
  service path and configured local health endpoint when the app is running;
- when the app is not running, starts the configured service on a random local
  port with local model files only, checks /api/v1/health, then stops only the
  process created by the validator;
- inspects one matching CPU/cu130 offline ZIP placed beside this folder.

Development overrides (optional):
Run the PowerShell file directly when testing a source tree or custom install:
  .\Run-Moonshine-Image-Test-Validator.ps1 `
    -ApplicationInstallRoot "C:\path\to\install" `
    -ApplicationUserDataRoot "C:\path\to\user-data" `
    -PythonEnvironmentRoot "C:\path\to\python-environment" `
    -PythonEnvironmentFlavor cpu `
    -ServiceProjectPath "C:\path\to\server" `
    -ApplicationConfigPath "C:\path\to\config.json"
All overrides are optional. The ordinary double-click workflow discovers the
installed application and active environment automatically.

Privacy:
- Reports stay on this computer until you send them yourself.
- The validator does not upload logs, images, models or user files.
- User profile paths, user names and query-string credentials are redacted.
- The package contains only the public release key, never the private key or
  R2 credentials.

This validator and the current Moonshine-Image installer are unsigned. Windows
may display a SmartScreen or security warning.
