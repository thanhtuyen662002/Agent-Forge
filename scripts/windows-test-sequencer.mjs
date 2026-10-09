import { BaseSequencer } from 'vitest/node';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const profile = require('./windows-test-profile.cjs');

// Use Vitest's supported shard hook and retain its inherited within-shard sort.
// This integration is selected only by the protected complete Windows runner.
export default class WindowsTestSequencer extends BaseSequencer {
  async shard(files) {
    try {
      const { root, shard, maxWorkers } = this.ctx.config;
      if (process.platform !== 'win32' || shard?.count !== 4 || !Number.isInteger(shard.index) ||
        shard.index < 1 || shard.index > 4 || maxWorkers !== 1) throw new Error();
      const metadata = profile.context(profile.read(path.join(root, profile.PROFILE_DIR, `input-${shard.index}.json`)));
      if (metadata.algorithm !== 'vitest-max-observed-lpt-four-shards-v1' || files.some(file => file.project.name)) throw new Error();
      const discovered = profile.inventory(files.map(file => profile.publicId(root, file.moduleId)));
      if (JSON.stringify(discovered) !== JSON.stringify(metadata.inventory)) throw new Error();
      const selected = new Set(profile.assignedFiles(metadata)[shard.index - 1]);
      return files.filter(file => selected.has(profile.publicId(root, file.moduleId)));
    } catch {
      throw new Error('CI_WINDOWS_PROFILE_INVALID');
    }
  }
}
