# ltm/ — Local Long-Term Memory

Project-local memory managed by ltm-power.

## Commit policy: repo-portable tooling, local-private memory

**Commit:** `ltm/bin/ltm.py`, `ltm/config.json`, `ltm/manifest.json`, this README.
**Do NOT commit:** `ltm/store/`, `ltm/runtime/`, `ltm/reports/`, `ltm/snapshots/`.

If the hook uses an absolute path, review `.kiro/hooks/ltm-postturn-capture.kiro.hook` before committing.

## Commands

Read `python_cmd` from `ltm/config.json`.

- `python ltm/bin/ltm.py files --limit 10`
- `python ltm/bin/ltm.py health`
- `python ltm/bin/ltm.py checkpoint --summary "..."`
- `python ltm/bin/ltm.py validate`
- `python ltm/bin/ltm.py repair`
- `python ltm/bin/ltm.py purge-last --confirm`
- `python ltm/bin/ltm.py purge-all --confirm`
- `python ltm/bin/ltm.py teardown --confirm`
