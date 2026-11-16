# Changelog

## Unreleased

- Add optional school-name-to-organization-ID mappings in Hydro system settings for preparing broadcast packages (for example, `西华师范大学` → `cwnu`).
- Keep organization resources, team references and both event-feed views consistent; preserve fallback IDs, historical events and existing resume tokens.
- Validate mapping syntax, IDs and collisions, with regressions for configuration changes and replay.
- Add optional custom groups selected by school name and team-account lists, with contest scoping and resumable membership updates.
- Preserve the built-in participants/observers groups and keep starred teams out of custom-group official scoreboards.
- Include a five-group school/cohort example and document the distinction between CCS groups, organization IDs and broadcast display settings.

## 1.1.0 — 2026-11-16

- Added `problems.test_data_count`, read-only `runs` resources and test-case events for ICPC Live judging progress.
- Refresh active feeds on Hydro `record/change` and `record/judge`, wake connected streams after commits, and retain polling as a fallback.
- Preserve test-case identities/ordinals across parallel completion, replay and restart; remove old runs when an observed rejudge resets its cases.
- Keep native journal scoring while exposing pending record states, and apply freeze filtering to current runs and historical replay.
- Fix `/api/ccs` being intercepted by Hydro's built-in `/api/:op` route.
- Document judge-side batching limits and add live-progress, freeze, rejudge and resume regressions. Existing log scopes and tokens remain compatible.

## 1.0.0 — 2026-11-16

- Extracted the Hydro XCPC CCS implementation into an independent addon.
- Added `/api/ccs`, dedicated system settings, Basic authentication and an optional unfrozen read-only API key.
- Scoped both authentication modes to an explicit domain/contest allowlist.
- Preserved scoreboard, freeze filtering, durable NDJSON events and token-based resume.
- Isolated event collections and token namespace from the original integration.
- Cancelled active streams when the addon is unloaded.
- Added installation/API documentation, ICPC Live/CDS examples and GitHub Actions.
- Aligned unfrozen API-key validation with HTTP clients: visible ASCII without whitespace, 32–1024 characters.
- Licensed the standalone addon under MIT.
