import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
// Fixtures comparing physical identities must start from a physical temp root.
// macOS /var -> /private/var and an explicitly aliased TMPDIR are equivalent.
// Tests of logical aliases still create their own symlink after this boundary.
export function canonicalMkdtempSync(prefix){return realpathSync(mkdtempSync(prefix));}
// The physical temp root, for fixtures the code under test refuses to reach
// through a symlinked ancestor (macOS /var, the portability run's aliased TMPDIR).
export function physicalTempRoot(){return realpathSync(tmpdir());}
// A physical root short enough to bind a Unix socket up to 70 bytes below it:
// sockaddr_un.sun_path holds 103 bytes on macOS and 107 on Linux. A long temp
// root (macOS /var/folders, the portability run's aliased TMPDIR) falls back to
// /tmp. A bind past the limit fails, or on macOS binds a truncated name.
export function socketTempBase(){const root=realpathSync(process.platform==='darwin'?'/tmp':tmpdir());return root.length<=32?root:realpathSync('/tmp');}
