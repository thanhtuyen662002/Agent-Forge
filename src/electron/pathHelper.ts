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
  // Vitest exercises packaged navigation with Windows-style fixture paths on
  // every CI runner. `fileURLToPath()` returns `/C:/...` for a Windows file
  // URL when the test runs on Linux, while Electron on Windows returns
  // `C:\\...`. Normalize those portable drive paths with win32 semantics so
  // the security decision does not depend on the host running the test.
  const portableWindowsPath = (value: string): string | null => {
    const slashNormalized = value.replace(/\\/g, '/');
    const drivePath = slashNormalized.match(/^\/?([A-Za-z]:\/.*)$/);
    if (!drivePath) {
      return null;
    }
    return path.win32.normalize(path.win32.resolve(drivePath[1])).toLowerCase();
  };

  const portableLeft = portableWindowsPath(left);
  const portableRight = portableWindowsPath(right);
  if (portableLeft !== null || portableRight !== null) {
    // A drive-qualified path must only compare equal to another drive-
    // qualified path. Falling back to native path resolution here could make
    // a malformed mixed-platform value appear trusted.
    return portableLeft !== null && portableRight !== null && portableLeft === portableRight;
  }

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
