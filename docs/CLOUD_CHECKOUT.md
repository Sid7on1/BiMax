# Cloud checkout handoff — 2026-11-01

The current source snapshot is on the default branch, `main`, in
`Sid7on1/BiMax`. Import the repository with its default branch in a cloud
workspace:

```sh
git clone https://github.com/Sid7on1/BiMax.git
cd BiMax
```

Snapshot `5c72fe54` was first uploaded to
`feat/sovereign-retrieval-and-layout-extraction`, then merged with the existing
`main` history. Both histories are retained. The former `main` changed 1,110 paths
from the shared ancestor: 1,051 already matched the current snapshot, and there
were no files present only in the former `main`. The remaining differences are
older source/configuration/documentation versions and shell-script modes. The
merge deliberately retains the current snapshot's complete file tree and modes;
only this handoff is updated afterward. No history is force-pushed.

The author and committer use `Sid7on1 <sid7vish@gmail.com>`. GitHub's commit API
already associates snapshot `5c72fe54` with the `Sid7on1` account. GitHub
authentication uses that account too. Placing the commits on the default branch
makes them eligible for profile contribution credit; GitHub documents up to
24 hours for the contribution graph to refresh:
[Troubleshooting missing contributions](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions).

## Source and local state

Source, tests, scripts, lockfiles, documentation, reviewed third-party source and
trackable evidence are included. Existing ignore rules keep credentials, installed
dependencies, local runtime state, logs and generated app/native outputs local.
Record 102's disposable compiled qualification engine is also excluded; its source
and qualification reports remain available.

The marketing site and mobile project are separate repositories, as documented
in the product-reset records; they are not copied into this source snapshot.

## Environment requirements and known setup gaps

- The root and app manifests require Node `>=24.15.0 <25`. Build/test scripts also
  use Bun; native Desktop compilation and installed-app verification require macOS
  and Apple development tools.
- Root dependencies can be installed with `npm ci` after selecting the required
  Node version. Install scripts have not been exercised in a fresh cloud checkout
  for this handoff.
- `app/package.json` and its lockfile currently link `@bimax/protocol` and
  `desktop-responder` through absolute paths under
  `/Users/vishsiddharth/Desktop/bimax-mobile`. A cloud machine must obtain the
  matching mobile project and relink those two dependencies. The app's mobile
  preparation also builds `packages/core`, `apps/relay` and
  `apps/desktop-responder` in that project. These dependencies are an existing
  portability gap recorded in product-reset audit 117; this handoff preserves
  the implementation rather than claiming a standalone cloud app build.
- Supply provider credentials through the cloud workspace's secret settings.
  Private local configuration is intentionally absent from Git.

## Verification scope

This is a source synchronization, not new product qualification. The repository
inventory was checked for oversized files and symlinks, and text files were
scanned using `src/security/secret.scan.ts`. Recognized matches were reviewed as
test fixtures, captured test output, example URLs or masked placeholders. No
application tests, installed-app journeys or fresh-cloud build were run as part
of the synchronization.

Staging preserved the inventoried file bytes, with no remaining untracked source,
unstaged edits or nested Git repositories. `git diff --cached --check` reports
whitespace warnings in the existing snapshot, including archived and vendored
source; this synchronization does not rewrite those files to clear the warnings.

For the default-branch merge, file-tree comparison against `5c72fe54` must show
only this handoff changing. Both the previous `main` and `5c72fe54` must be
ancestors of the merge. These checks preserve the current runtime source exactly;
they do not establish fresh-cloud build or product acceptance.

Guiding documents: `product-reset/README.md`, `01_CURRENT_REPO_AUDIT.md`,
`05_TARGET_ARCHITECTURE.md`, `06_REPO_SPLIT_RUNBOOK.md`,
`08_ACCEPTANCE_GATES.md`, and the C01 dirty-repository journey. Existing product
status and release Targets remain as recorded in those documents.
