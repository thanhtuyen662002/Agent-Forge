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

const TRUSTED_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseTrustedDevOrigin(devServerUrl: string | undefined): URL | null {
  if (!devServerUrl || typeof devServerUrl !== 'string' || devServerUrl.trim() === '') {
    return null;
  }

  try {
    const parsed = new URL(devServerUrl);
    // Development renderers must stay on an explicitly loopback HTTP(S) origin.
    // Credentials are never meaningful for the renderer and make origin
    // comparisons deceptive. Checking the parsed hostname (rather than a
    // string prefix) rejects lookalikes such as localhost.evil.example.
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || !TRUSTED_DEV_HOSTS.has(parsed.hostname)
      || parsed.username
      || parsed.password
    ) {
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

/**
 * Return the navigation policy used by both the BrowserWindow navigation guard
 * and privileged IPC sender checks. Keeping one derived policy prevents the
 * renderer and IPC boundaries from disagreeing after a configuration change.
 */
export function resolveRendererNavigationPolicy(options: {
  isPackaged: boolean;
  appPath?: string;
  devServerUrl?: string;
}): RendererNavigationPolicyOptions {
  const target = resolveRendererTarget(options);
  return {
    isPackaged: options.isPackaged,
    rendererFilePath: target.type === 'file' ? target.target : undefined,
    devServerUrl: target.type === 'url' ? target.target : undefined,
  };
}

export interface IpcSenderFrameLike {
  url?: unknown;
}

export interface IpcInvokeEventLike {
  senderFrame?: IpcSenderFrameLike | null;
}

/**
 * Validate the frame that invoked a privileged IPC handler. Electron exposes
 * senderFrame for the actual invoking frame; requiring it avoids trusting a
 * stale or missing WebContents URL and also rejects synthetic/malformed events.
 */
export function isTrustedIpcSender(
  event: unknown,
  options: RendererNavigationPolicyOptions,
): boolean {
  if (!event || typeof event !== 'object') return false;
  const frame = (event as IpcInvokeEventLike).senderFrame;
  if (!frame || typeof frame !== 'object' || typeof frame.url !== 'string') return false;
  return isAllowedRendererNavigation(frame.url, options);
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
    if (!parseTrustedDevOrigin(options.devServerUrl)) {
      throw new Error(
        '[Security/Path] VITE_DEV_SERVER_URL must use an HTTP(S) loopback origin (localhost, 127.0.0.1, or [::1]) without credentials.'
      );
    }
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
