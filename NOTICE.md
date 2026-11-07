# NOTICE — third-party software

## SmartSpectra SDK (Presage Technologies)

This project depends on the SmartSpectra SDK by Presage Technologies
(Presage Security, Inc. d/b/a Presage Technologies):

- Package: `@smartspectra/node-sdk` (pinned to v3.4.0 in `package.json`),
  installed via npm. Its per-platform native runtimes are pulled in as
  dependencies of that package.
- Documentation: <https://smartspectra.presagetech.com/> (see in
  particular `/docs/nodejs`, `/docs/nodejs/metrics`,
  `/docs/telemetry-and-privacy`, and the model cards for breathing rate).

The SDK is proprietary software made available under Presage's Terms of
Service (<https://physiology.presagetech.com/tos>). This repository does
**not** vendor, redistribute, or modify any Presage code; it uses the
published npm package as a dependency, as the terms intend. No Presage
trademark, trade name, or logo is used.

This app requests only the breathing-metrics bundle and disables the SDK's
aggregate telemetry (`enableTelemetry: false` in
`src/signal/sdkWorker.ts`), as described in `docs/CONSENT_AND_DATA.md §5`.

## Building with the AI toolchain

Development used Presage's public agent resources: the `using-smartspectra`
agent skill and the SmartSpectra documentation (and the hosted MCP server
for account/usage context where available). All integration decisions that
came from those sources are recorded in `docs/SDK_NOTES.md`.
