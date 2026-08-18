import path from 'path';

export interface RendererTarget {
  type: 'url' | 'file';
  target: string;
}

export function resolveRendererTarget(options: {
  isPackaged: boolean;
  appPath?: string;
  devServerUrl?: string;
}): RendererTarget {
  if (options.devServerUrl) {
    return {
      type: 'url',
      target: options.devServerUrl,
    };
  }

  if (!options.isPackaged) {
    return {
      type: 'url',
      target: 'http://localhost:5173',
    };
  }

  const baseDir = options.appPath || process.cwd();
  return {
    type: 'file',
    target: path.join(baseDir, 'dist', 'index.html'),
  };
}
