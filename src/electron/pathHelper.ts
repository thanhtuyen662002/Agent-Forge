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
  if (options.isPackaged) {
    if (!options.appPath || typeof options.appPath !== 'string' || options.appPath.trim() === '') {
      throw new Error('[Security/Path] Canonical appPath is required in packaged mode to resolve embedded renderer.');
    }
    return {
      type: 'file',
      target: path.join(options.appPath, 'dist', 'index.html'),
    };
  }

  if (options.devServerUrl && typeof options.devServerUrl === 'string' && options.devServerUrl.trim() !== '') {
    return {
      type: 'url',
      target: options.devServerUrl,
    };
  }

  return {
    type: 'url',
    target: 'http://localhost:5173',
  };
}
