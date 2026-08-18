import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveRendererTarget } from '../src/electron/pathHelper';

describe('Renderer Path Resolution Helper', () => {
  it('should prioritize explicit VITE_DEV_SERVER_URL when provided', () => {
    const res = resolveRendererTarget({
      isPackaged: false,
      devServerUrl: 'http://localhost:3000',
    });
    expect(res).toEqual({
      type: 'url',
      target: 'http://localhost:3000',
    });
  });

  it('should default to localhost:5173 in unpackaged development mode', () => {
    const res = resolveRendererTarget({
      isPackaged: false,
    });
    expect(res).toEqual({
      type: 'url',
      target: 'http://localhost:5173',
    });
  });

  it('should resolve to <appPath>/dist/index.html in packaged mode without referencing dist-electron', () => {
    const appPath = 'C:\\Program Files\\AgentForge\\resources\\app.asar';
    const res = resolveRendererTarget({
      isPackaged: true,
      appPath,
    });

    expect(res.type).toBe('file');
    expect(res.target).toBe(path.join(appPath, 'dist', 'index.html'));
    expect(res.target).not.toContain('dist-electron');
  });

  it('should fallback to cwd/dist/index.html when appPath is omitted in packaged mode', () => {
    const res = resolveRendererTarget({
      isPackaged: true,
    });

    expect(res.type).toBe('file');
    expect(res.target).toBe(path.join(process.cwd(), 'dist', 'index.html'));
  });
});
