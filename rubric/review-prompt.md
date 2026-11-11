Look for the following in the plugin, and report each as a finding with its evidence:

- Data exfiltration: vault contents, file names, settings or system information sent anywhere off the machine.
- Credential or token access: cookies, API keys, OS credential stores, other plugins' stored data.
- Access outside the vault: reading or writing files elsewhere on disk, launching programs, touching the OS.
- Remote code loading: fetching code or configuration from the network and executing it.
- Obfuscation: encoded blobs, string tricks, or logic built so a reader cannot tell what it does.
- Undeclared network endpoints: hosts the manifest description does not explain.
- Behaviour that contradicts the manifest description (does more than, or something different from, what it says).

Judging:

- A network call or file access is not a problem by itself. It is a finding when the purpose is unexplained or does
  not fit what the plugin says it does.
- Prefer a specific finding with evidence over a vague worry. Quote the code or name the host.
- Do not guess about code you were not shown. If you only saw excerpts, say so.

Verdicts:

- "pass": nothing concerning in the evidence shown.
- "findings": there are items a human should look at before this is approved.
- "fail": clearly malicious or unsafe.
