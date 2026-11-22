# Changelog

## 0.1.2 - 2026-11-22

- Fixed: one compaction per crossing. On a model with `limit.context` 0, `session.idle` could arrive while a finished step was still asking the host about the model, and both paths sent `session.summarize`, so every crossing compacted twice. Seen live on OpenCode 1.19.0 (two `forcing compaction` lines 11 ms apart, two summary messages); now one.

## 0.1.1 - 2026-11-18

- Releases now publish from GitHub Actions with npm trusted publishing (OIDC) and a provenance attestation. No npm token is involved. No code changes.

## 0.1.0 - 2026-11-18

First release.

- Forces a session compaction (`session.summarize`) when a finished assistant step's context reaches the limit. The default limit is 200000 tokens.
- The limit is set by the plugin option `limit` or the `OPENCODE_COMPACT_AT_TOKENS` env var, in that order. It accepts `k`/`m` suffixes, and `0` turns the plugin off.
- Guards come from opencode-goal-pro-max-complete-plugin v1.5.3: one pending request per session, a 3-step retry window, a cap of 3 failures, a hold after 2 compactions that don't lower the context, a grace step for the host's own compaction, and an idle backstop.
- Unit tests (node:test) and a live A/B smoke against a real `opencode serve`.
