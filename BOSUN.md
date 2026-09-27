# Bosun

Bosun is an agentic software factory: a Captain coordinating Managers, each running a
crew of planner/designer/execution/reviewer bots across Projects and Features. It is
built on the T3 Code harness and tracks T3 Code as its upstream.

The name comes from _boatswain_ ("bosun") — the officer who runs the deck crew under
the captain.

## Remotes

| Remote   | URL                                   | Role                                 |
| -------- | ------------------------------------- | ------------------------------------ |
| `origin` | https://github.com/sanjay-29218/bosun | This repo. Pull and push here.       |
| `t3code` | https://github.com/pingdotgg/t3code   | T3 Code. Pull from here; never push. |

`origin` is git's default name for the remote a clone was created from.

The T3 Code remote is deliberately **not** named `upstream`. T3 Code's repository
identity resolver prefers a remote named `upstream` over `origin`, so naming it that
makes Bosun resolve to the T3 Code project and collide with it in the app.

## Branches

- **`main`** — the product and default branch. All Bosun work and PRs land here.

Upstream T3 Code is pulled from the `t3code` remote; there is no separate mirror branch.

## Syncing upstream

```bash
git fetch t3code
git checkout main && git merge t3code/main
```

One rule keeps it clean: keep Bosun-only edits localized, so `git merge t3code/main`
stays a trivial merge.

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

The desktop and web icons are already replaced with the Bosun mark (`assets/bosun/`).
Still to do before a public release: replace the Apple Icon Composer projects
(`assets/*/app-icon.icon`) and marketing artwork, use your own mobile bundle ids / EAS
/ Clerk / signing team, and remove references to T3 Code's domains (`t3.codes`,
`app.t3.codes`). Do not ship under T3 Code's identifiers or credentials.

## License

MIT (`LICENSE`, © T3 Tools Inc.). Keep the copyright and permission notice, plus the
third-party notices. MIT does not grant trademark rights in the "T3 Code" / "T3 Tools"
names or logos.
