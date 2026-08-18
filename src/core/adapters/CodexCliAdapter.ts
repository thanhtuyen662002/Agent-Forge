import { LocalCliAdapterBase, LocalCliAdapterOptions } from './LocalCliAdapterBase';
import { Capability } from '../types/domain';

export class CodexCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-codex-cli';
  public readonly name: string = 'Codex CLI';

  constructor(options?: LocalCliAdapterOptions) {
    super(options);
  }

  protected getDefaultExecutable(): string {
    return 'codex';
  }

  public async getCapabilities(): Promise<Capability[]> {
    return [
      'CODING',
      'FILESYSTEM_EDIT',
      'TEST_EXECUTION',
      'LARGE_CONTEXT',
    ];
  }
}
