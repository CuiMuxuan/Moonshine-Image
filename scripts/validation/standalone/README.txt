Moonshine-Image Test Validator
==============================

1. Extract this entire validator ZIP to a normal folder.
2. Double-click Run-Moonshine-Image-Test-Validator.cmd.
3. Wait until the window reports completion. A full run downloads and hashes
   the test installer, so it can take several minutes.
4. Send the generated Moonshine-Image-validation-*.zip from your Desktop to
   the Moonshine-Image developer.

The validator automatically:
- checks the signed test release manifest and application files;
- probes HTTP HEAD, Range, size and full download hashes;
- detects a standard Moonshine-Image NSIS installation;
- checks the managed environment when one exists;
- inspects one matching CPU/cu130 offline ZIP placed beside this folder.

Privacy:
- Reports stay on this computer until you send them yourself.
- The validator does not upload logs, images, models or user files.
- User profile paths, user names and query-string credentials are redacted.
- The package contains only the public release key, never the private key or
  R2 credentials.

This validator and the current Moonshine-Image installer are unsigned. Windows
may display a SmartScreen or security warning.
