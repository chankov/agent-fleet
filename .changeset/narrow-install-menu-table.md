---
"@chankov/agent-skills": patch
---

**guided-workspace-setup:** render every interactive table compact so it fits a standard terminal width in the `pi-ask-user` widget.

The Step 6 install menus, the Step 9 plan summary, and the Step 4/5 doctor-findings table all forced horizontal overflow — long `installed · …` state strings on every menu row, a separate `Rec` column, full-sentence purposes, and a Step 9 mega-table with `Target paths` + `Notes` columns and an `Artifacts` cell listing every skill name. Users had to zoom out, which re-rendered the widget and caused flicker. Now:

- **Step 6 menus** use short status tokens (`ok`/`upd`/`mod`/`cflt`/`gone`/`new`/`pkg`/`—`/`brk`) with a one-line legend, fold the `★` recommendation mark into the item name (no `Rec` column), and cap purpose/group cells.
- **Step 9 confirmation** renders as compact action-grouped lines (Add / Refresh / Remove / Keep-count / Records / Method) instead of a wide table; target paths are omitted and the "Changes since" delta is shown as short per-change bullets rather than one long line.
- **Doctor-findings table** uses short issue/fix phrases.
