import path from 'path';
import { fileURLToPath } from 'url';

export interface RendererTarget {
  type: 'url' | 'file';
  target: string;
}

export interface RendererNavigationPolicyOptions {
  isPackaged: boolean;
  /** The exact file path returned by resolveRendererTarget in packaged mode. */
  rendererFilePath?: string;
  /** The configured development URL returned by resolveRendererTarget in dev mode. */
  devServerUrl?: string;
}

function parseTrustedDevOrigin(devServerUrl: string | undefined): URL | null {
  if (!devServerUrl || typeof devServerUrl !== 'string' || devServerUrl.trim() === '') {
    return null;
  }

  try {
    const parsed = new URL(devServerUrl);
    // Development renderers must stay on a local HTTP(S) origin. Credentials are
    // never meaningful for the renderer and make origin comparisons deceptive.
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * Decide whether a navigation or redirect stays inside the trusted renderer
 * boundary. The check is deliberately fail-closed and does not use string
 * prefixes, which would accept lookalike hosts, ports, or file paths.
 */
export function isAllowedRendererNavigation(
  candidateUrl: string,
  options: RendererNavigationPolicyOptions,
): boolean {
  if (typeof candidateUrl !== 'string' || candidateUrl.trim() === '') {
    return false;
  }

  let candidate: URL;
  try {
    candidate = new URL(candidateUrl);
  } catch {
    return false;
  }

  if (options.isPackaged) {
    if (candidate.protocol !== 'file:' || candidate.hostname || candidate.username || candidate.password) {
      return false;
    }
    if (!options.rendererFilePath || typeof options.rendererFilePath !== 'string') {
      return false;
    }
    try {
      return samePath(fileURLToPath(candidate), options.rendererFilePath);
    } catch {
      return false;
    }
  }

  const trustedOrigin = parseTrustedDevOrigin(options.devServerUrl);
  if (!trustedOrigin || candidate.username || candidate.password) {
    return false;
  }

  return candidate.protocol === trustedOrigin.protocol
    && candidate.hostname === trustedOrigin.hostname
    && candidate.port === trustedOrigin.port;
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
