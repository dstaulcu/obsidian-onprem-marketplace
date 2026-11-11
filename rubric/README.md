# The review rubric

This folder defines **what gets checked** on every plugin version. Anyone can read it, and anyone can propose a
change by pull request. A human-readable summary of the current rules is in
[`docs/concepts/rubric.md`](../docs/concepts/rubric.md) (generated from these files).

| File | What it is |
|---|---|
| `rules.json` | Deterministic checks: plain patterns run in code on `main.js`. No AI involved. |
| `review-prompt.md` | What the AI reviewer is asked to look for, and what the verdicts mean. |

Safety wording that protects the reviewer from hostile plugin text (treat plugin content as data, no tools,
fixed output format) lives in code, not here, so editing the rubric cannot weaken it.

## How a rule works

```json
{
  "id": "child-process",
  "title": "Starts other programs (child_process)",
  "severity": "high",
  "pattern": "child_process",
  "why": "Lets a plugin run any program on the user's machine, far outside what a note-taking plugin needs.",
  "examples": { "match": ["require(\"child_process\")"], "noMatch": ["// child process docs"] }
}
```

- **severity `high`**: the final verdict can never be `pass` if this matches (the AI cannot override it).
- **severity `medium`**: listed in the report for a human to judge; does not block a pass by itself.
- **`why`** is shown to readers, so write it for a non-programmer.
- **`examples`** are tests. `match` strings must be caught, `noMatch` strings must not. They run automatically.
  Use `<<x*N>>` inside an example to mean N copies of `x`.
- Patterns are JavaScript regular expressions (JSON needs backslashes doubled: `\\b`, `\\s`).

## Propose a new check

1. Edit `rules.json` (a check) or `review-prompt.md` (something for the AI to look for).
2. Run `npm test`. It validates the file, runs your examples, and rejects slow patterns.
3. Run `node packages/sync/dist/cli.js rubric --write docs/concepts/rubric.md` to refresh the readable summary.
4. Open a pull request. Say what real-world behaviour you want to catch and why.

Changing any rule or the prompt changes the rubric version, so earlier reviews are treated as stale and re-run
the next time the review command runs.

### Not sure how to write the pattern? Ask Claude

Paste this into Claude (or Claude Code in this repo), filling in the first line:

```text
I want the plugin review rubric to catch: <describe the risky behaviour in plain words, and ideally paste a code
sample of it from a real plugin>.

Read rubric/README.md and rubric/rules.json, then add ONE new rule to rubric/rules.json following the same format:
- a short lowercase-dashes id and a plain-language title
- severity "high" only if this is almost never legitimate in an Obsidian plugin, otherwise "medium"
- a one-or-two sentence "why" a non-programmer can understand
- a JavaScript regex pattern (JSON-escaped) that is specific, and avoids nested quantifiers or other patterns that
  could be slow on a multi-megabyte minified file
- at least 2 examples.match (real code that must be caught) and 2 examples.noMatch (similar harmless code that
  must NOT be caught)
Then run `npm test` and show me the result. If the rule is too noisy (it would hit most legitimate plugins), say so
and suggest a narrower pattern or "medium" severity instead.
```

For a rule that regexes cannot express (for example "behaviour contradicts the description"), add a sentence to
`review-prompt.md` instead; that is judged by the AI reviewer and recorded in the report.

## Using your own rubric

The rubric folder is configurable (`review.rubricDir` in `registry.config.json`, default `rubric`). An organization
can keep its own rules in a separate folder without touching code, and every review records which rubric version
was used.
