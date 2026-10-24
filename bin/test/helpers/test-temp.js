import {mkdtempSync,realpathSync} from 'node:fs';
// Fixtures comparing physical identities must start from a physical temp root.
// macOS /var -> /private/var and an explicitly aliased TMPDIR are equivalent.
// Tests of logical aliases still create their own symlink after this boundary.
export function canonicalMkdtempSync(prefix){return realpathSync(mkdtempSync(prefix));}
