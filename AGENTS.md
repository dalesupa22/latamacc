# LATAMACC — Git workflow

Repository: https://github.com/dalesupa22/latamacc

- This directory is the Git root. Inspect `git status` before editing and committing; preserve other agents' work.
- Commit completed, reviewed changes and push to this repository as requested by Danny. Use clear commit messages and report the resulting commit URL. Never claim a push or deployment without checking it.
- On the GPU, Git uses the existing XertifyDannyAgent credential helper and DannyAgent bot identity. Do not run personal `gh auth login`, embed tokens in remotes, or print credentials. For GitHub CLI use `gh-danny -R dalesupa22/latamacc <command>`.
- Do not force-push, delete branches/tags/repositories, rewrite existing history, or bypass the pre-push guard. Fetch before resolving a remote divergence and preserve both agents' commits.
- Keep node_modules, data/, SQLite databases/backups, builder email exports, environment files and credentials outside Git. Stage explicit source files after reviewing them.
- Runtime: Node 24, `node server.mjs`, localhost port 8790. Production runs as systemd user services `latamacc-web` and `latamacc-tunnel`; apply server changes with `systemctl --user restart latamacc-web` instead of starting another process on 8790. `npm test` is currently a placeholder that exits with an error; it is not a real test suite. Use appropriate syntax and functional checks for the change without modifying live user data.
- Domain: latamacc.si. The legacy wrangler.jsonc is unused by the current Node server; do not deploy its old domain configuration.
- Committing/pushing is separate from deployment. Follow the target environment and deployment scope of the user's request.
