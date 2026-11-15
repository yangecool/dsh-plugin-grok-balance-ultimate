# Changelog

All notable changes to this plugin are documented here. Version numbers follow
[SemVer](https://semver.org/).

## [0.1.0] - 2026-11-15

First release: Grok subscription integration for the DeepSeek Harness Web GUI,
ported from the grok-harness `llm-grok`/`grok-auth` packages and verified
against the grok-build 1.0.45 protocol.

### Added

- **xAI OAuth device login**: `登录 Grok` starts the RFC 8628 flow at
  `auth.x.ai`, the Host polls the token endpoint until the browser approval
  lands, and the session is persisted into the grok-build-compatible
  `~/.grok/auth.json` (one `issuer::client_id` scope, other scopes preserved,
  mode 0600, refresh-token rotation inside the final minute of the TTL).
- **Usage page** (sidebar entry): subscription tier, credit-usage percent,
  current billing period with reset countdown, prepaid balance, per-cycle
  usage history, the auto top-up rule, and the account identity — served from
  the subscription proxy's `/billing?format=credits`, `/user?include=subscription`,
  and `/auto-topup-rule` with TTL caching, single-flight de-duplication, and
  stale-last-good fallback.
- **Composer credit ring**: a single theme-colored ring on Grok-model
  conversations showing the remaining credit, with a popover carrying the
  period countdown, prepaid balance, and links to the page and the SuperGrok
  console.
- **Grok LLM route**: the `grok` provider (`grok-4.7`, `grok-4.7-build-fast`,
  `grok-4.6`, `grok-4.5`, 500k context, Responses API) registered on the `ctx.llm` seam — subscription
  mode rides the shared session against `cli-chat-proxy.grok.com` with the
  full grok-shell identity header set; API-key mode (`XAI_API_KEY`) remains
  available. No credential is ever pasted.
- **Live model catalog**: the picker merges the account's `/models` listing
  over the built-in table with a five-minute cache, so newly served models
  appear without a plugin release.
- **Teardown gate**: pending device polls and token rotations are cancelled
  when the plugin unloads and never persist a login afterwards; the web-search
  model is read per call so a settings save applies to the next search.
- **Subscription web search**: a `grok` web-search provider on the harness
  web seam (one `/responses` call with the server-side `web_search` tool,
  citations from `url_citation` annotations) that owns Grok-model sessions
  under session-aware provider selection, so `web_search` no longer fails
  with "no API key" on Grok conversations.
- **Models settings row**: a Grok account row at the bottom of
  Settings → Models with sign-in state, account e-mail, expiry, and sign-out.
- **Session-gated Host routes** under `/grok-balance`: the raw Web routes
  re-use the connection carrier's browser-session authentication
  (`connection.requestRejection`), answering 401/403 to untrusted peers.
- Host modules for the full chain: shared-store persistence, device-flow
  OAuth with discovery caching, account-surface normalizers, snapshot
  aggregation, and the web-search provider — with offline unit tests for
  every module and integration coverage of the real route table.
