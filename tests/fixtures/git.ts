/** The environment of the git processes the tests start. */
import { GIT_LOCATION } from '../../src/infra/environment.ts'

/**
 * The process environment with `extra`, and without the variables that tell git which repository to act on (`GIT_LOCATION`):
 * the tests run inside `git rebase --exec` inherit GIT_DIR, and a `git init` there would reinitialize the repository under test.
 */
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> =>
  // A fixed locale keeps git's own error text stable: one test matches on "bad config", which a translated git renames.
  ({ ...process.env, ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])), LC_ALL: 'C', LANG: 'C', ...extra })
