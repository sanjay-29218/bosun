# Bosun

Bosun is an agentic software factory: a Captain coordinating Managers, each running a
crew of planner/designer/execution/reviewer bots across Projects and Features. It is
built on the T3 Code harness and tracks T3 Code as its upstream.

The name comes from _boatswain_ ("bosun") — the officer who runs the deck crew under
the captain.

## Remotes

| Remote     | URL                                   | Role                                 |
| ---------- | ------------------------------------- | ------------------------------------ |
| `origin`   | https://github.com/sanjay-29218/bosun | This repo. Pull and push here.       |
| `upstream` | https://github.com/pingdotgg/t3code   | T3 Code. Pull from here; never push. |

`origin` is git's default name for the remote a clone was created from.

## Branches

- **`bosun`** — the product and default branch. All Bosun work and PRs land here.
- **`main`** — a pristine mirror of `upstream/main`. Never commit to it; it exists only
  so "what is new upstream" stays a clean fast-forward.

## Syncing upstream

Keep `main` current, then fold it into the product:

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout bosun && git merge main
```

Or merge upstream directly into the product branch:

```bash
git fetch upstream && git checkout bosun && git merge upstream/main
```

Two rules keep this clean:

- Never commit to `main`.
- Keep Bosun-only edits localized, so `git merge main` stays a trivial merge.

## Branding scope

Renamed for Bosun (desktop):

- app id `com.bosun.desktop`
- app/installer names `Bosun`, `Bosun (Dev)`, `Bosun (Alpha)`, `Bosun (Nightly)`
- release artifact `Bosun-<version>-<arch>.<ext>`

Intentionally still T3 Code internally, to keep upstream merges cheap:

- npm workspace scope `@t3tools`
- environment prefix `T3CODE_`
- `t3code://` protocol scheme, user-data directory, Linux WM class
- the `t3` CLI

Before any public release, replace the T3 Code brand assets and logos, use your own
mobile bundle ids / EAS / Clerk / signing team, and remove references to T3 Code's
domains (`t3.codes`, `app.t3.codes`). Do not ship under T3 Code's identifiers or
credentials.

## License

MIT (`LICENSE`, © T3 Tools Inc.). Keep the copyright and permission notice, plus the
third-party notices. MIT does not grant trademark rights in the "T3 Code" / "T3 Tools"
names or logos.
