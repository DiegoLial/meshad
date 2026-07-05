# @meshad/cli

Turn your AI agent's idle time into revenue. Detects when your agent is
thinking, shows one signed, sponsored line/block/panel in your terminal's
footer, and clears it the instant the response arrives.

This is a public mirror of `apps/cli` from the private `meshad-core`
repository, published here so the CLI can be installed without access to
the core platform's source. The source of truth is `meshad-core`; this
copy is updated whenever the CLI changes there.

## Install

```bash
curl -fsSL https://meshad.io/install | sh
```

or manually:

```bash
git clone https://github.com/DiegoLial/meshad.git
npm install -g ./meshad/cli
```

Then:

```bash
meshad init          # explicit opt-in + registration — shows exactly what's collected
meshad demo          # simulated agent, real ad flow, no registration needed
meshad run -- aider  # wrap any CLI — ads render only while it's idle
meshad earnings      # your earnings, straight from the ledger
```

## Privacy, in 10 lines

1. Only 5 signals ever leave your machine: when processing starts/stops,
   the duration, a rotatable anonymous UUID, and the terminal type.
2. Every event is validated against the public schema **before** it's
   queued — an out-of-contract event throws (a client bug, not a
   condition to handle).
3. `meshad status --explain` shows the exact bytes of the last batch sent,
   and where it went.
4. The `run` wrapper only observes the *timing* of your command's output
   bytes — the chunks pass through untouched; the detector only sees
   timestamps.
5. An ad only renders with a valid Ed25519 network signature; a tampered
   payload is silently dropped.
6. No TTY → no render. No network → no ad, no error. Always fail-closed.
7. `meshad pause forever` and `meshad uninstall` do exactly what they say,
   no dark patterns.
8. A local frequency cap (default 6/h) is enforced before any request.
9. An impression only counts after ≥2s of real on-screen display during
   an actual wait.
10. Config lives in plain sight at `~/.config/meshad/config.json` (mode
    0600), never obfuscated.

## Languages

The CLI speaks English and Portuguese (pt-BR). Resolution order:
`MESHAD_LANG` → `meshad config lang pt-BR` → the system `LANG` → English.
`--help` screens stay in English (dev-tool convention).

## Supported terminals / agents

`claude-code`, `gemini-cli`, `codex`, `aider`, `opencode`, `cursor`,
`windsurf`, `kiro`, `continue`, and a generic `other` fallback for
anything else — `meshad run -- <your command>` works with any CLI.
