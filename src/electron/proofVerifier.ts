import fs from 'fs';
import path from 'path';

// Executed by the supervisor, not supplied by the implementation worker.
const actual = fs.readFileSync(path.join(process.cwd(), '.agentforge-pilot-proof.txt'));
if (!actual.equals(Buffer.from('SELF_HOST_PROOF_OK\n', 'utf8'))) {
  process.stderr.write('Proof bytes differ from SELF_HOST_PROOF_OK followed by one LF newline.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('PROOF_BYTES_VERIFIED\n');
}
