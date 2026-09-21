---
"@chankov/agent-fleet": patch
---

Harden Hub recovery, add fail-closed native write isolation, and confine scout to an isolated snapshot.

Agent cancellation is fenced with fail-closed recovery categories, trusted runtime checks, and protocol diagnostics. Native child writes are allowlisted and kernel-enforced (bubblewrap/seatbelt); glob and escape refusals are reported before a missing sandbox backend. Scout runs against an isolated snapshot with filesystem data-path boundaries, copies only Pi runtime credentials into a private directory, and removes that directory after the phase — including Darwin tmpdir aliases. Project philosophy is documented as the shared source of intent.
