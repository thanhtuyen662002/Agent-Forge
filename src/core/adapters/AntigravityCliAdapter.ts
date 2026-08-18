import { LocalCliAdapterBase, LocalCliAdapterOptions } from './LocalCliAdapterBase';
import { Capability } from '../types/domain';

export class AntigravityCliAdapter extends LocalCliAdapterBase {
  public readonly id: string = 'prov-antigravity-cli';
  public readonly name: string = 'Antigravity CLI';

  constructor(options?: LocalCliAdapterOptions) {
    super(options);
  }

  protected getDefaultExecutable(): string {
    return 'agy';
  }

  public async getCapabilities(): Promise<Capability[]> {
    return [
      'PLANNING',
      'CODING',
      'REVIEW',
      'SECURITY_REVIEW',
      'LARGE_CONTEXT',
      'FILESYSTEM_EDIT',
      'TEST_EXECUTION',
    ];
  }
}
