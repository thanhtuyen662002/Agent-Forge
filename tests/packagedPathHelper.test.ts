import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  isAllowedRendererNavigation,
  isTrustedIpcSender,
  resolveRendererNavigationPolicy,
  resolveRendererTarget,
} from '../src/electron/pathHelper';

describe('Renderer Path Resolution Helper (Strict Precedence & Fail-Closed)', () => {
  it('should ignore VITE_DEV_SERVER_URL in packaged mode and return canonical appPath file target', () => {
    const appPath = 'C:\\Program Files\\AgentForge\\resources\\app.asar';
    const res = resolveRendererTarget({
      isPackaged: true,
      appPath,
      devServerUrl: 'http://malicious-or-dev-server:5173',
    });

    expect(res.type).toBe('file');
    expect(res.target).toBe(path.join(appPath, 'dist', 'index.html'));
    expect(res.target).not.toContain('dist-electron');
  });

  it('should throw deterministic error in packaged mode if appPath is missing or empty', () => {
    expect(() => {
      resolveRendererTarget({
        isPackaged: true,
      });
    }).toThrow('[Security/Path] Canonical appPath is required in packaged mode to resolve embedded renderer.');

    expect(() => {
      resolveRendererTarget({
        isPackaged: true,
        appPath: '   ',
      });
    }).toThrow('[Security/Path] Canonical appPath is required in packaged mode to resolve embedded renderer.');
  });

  it('should prioritize explicit devServerUrl in unpackaged development mode', () => {
    const res = resolveRendererTarget({
      isPackaged: false,
      devServerUrl: 'http://localhost:3000',
    });
    expect(res).toEqual({
      type: 'url',
      target: 'http://localhost:3000',
    });
  });

  it('should default to localhost:5173 in unpackaged development mode when devServerUrl is omitted', () => {
    const res = resolveRendererTarget({
      isPackaged: false,
    });
    expect(res).toEqual({
      type: 'url',
      target: 'http://localhost:5173',
    });
  });

  it('rejects non-loopback development URLs before the window can load them', () => {
    for (const devServerUrl of [
      'https://remote.example:5173',
      'http://localhost.evil.example:5173',
      'http://127.0.0.1.nip.io:5173',
      'http://user:pass@localhost:5173',
      'file:///tmp/renderer',
    ]) {
      expect(() => resolveRendererTarget({ isPackaged: false, devServerUrl })).toThrow('[Security/Path]');
    }
  });

  it('accepts only loopback development origins and exact configured ports', () => {
    for (const devServerUrl of ['http://localhost:5173', 'http://127.0.0.1:4173', 'http://[::1]:3000']) {
      const policy = resolveRendererNavigationPolicy({ isPackaged: false, devServerUrl });
      expect(isAllowedRendererNavigation(`${devServerUrl}/tasks`, policy)).toBe(true);
      expect(isAllowedRendererNavigation(`${devServerUrl.replace(/:\d+$/, ':9999')}/tasks`, policy)).toBe(false);
    }
  });

  it('allows only the exact configured development origin, including safe paths', () => {
    const options = { isPackaged: false, devServerUrl: 'http://localhost:5173' };
    expect(isAllowedRendererNavigation('http://localhost:5173/tasks', options)).toBe(true);
    expect(isAllowedRendererNavigation('http://localhost:51730/tasks', options)).toBe(false);
    expect(isAllowedRendererNavigation('http://localhost:5173.evil/tasks', options)).toBe(false);
    expect(isAllowedRendererNavigation('http://user:pass@localhost:5173/tasks', options)).toBe(false);
    expect(isAllowedRendererNavigation('https://localhost:5173/tasks', options)).toBe(false);
    expect(isAllowedRendererNavigation('not a URL', options)).toBe(false);
  });

  it('allows only the canonical packaged renderer file', () => {
    const rendererFilePath = path.join('C:\\Program Files\\AgentForge', 'dist', 'index.html');
    const canonical = 'file:///C:/Program%20Files/AgentForge/dist/index.html';
    const options = { isPackaged: true, rendererFilePath };

    expect(isAllowedRendererNavigation(canonical, options)).toBe(true);
    expect(isAllowedRendererNavigation(`${canonical}#task`, options)).toBe(true);
    expect(isAllowedRendererNavigation('file:///C:/Program%20Files/AgentForge/dist/other.html', options)).toBe(false);
    expect(isAllowedRendererNavigation('file:///C:/Users/Public/other.html', options)).toBe(false);
    expect(isAllowedRendererNavigation('https://localhost:5173', options)).toBe(false);
  });

  it('requires an invoking sender frame and applies the same policy to IPC', () => {
    const policy = { isPackaged: false, devServerUrl: 'http://localhost:5173' };
    expect(isTrustedIpcSender(null, policy)).toBe(false);
    expect(isTrustedIpcSender({ senderFrame: null }, policy)).toBe(false);
    expect(isTrustedIpcSender({ senderFrame: {} }, policy)).toBe(false);
    expect(isTrustedIpcSender({ senderFrame: { url: 'https://remote.example/' } }, policy)).toBe(false);
    expect(isTrustedIpcSender({ senderFrame: { url: 'http://localhost.evil:5173/' } }, policy)).toBe(false);
    expect(isTrustedIpcSender({ senderFrame: { url: 'http://localhost:5173/tasks' } }, policy)).toBe(true);
  });
});
