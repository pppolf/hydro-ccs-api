# Changelog

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
