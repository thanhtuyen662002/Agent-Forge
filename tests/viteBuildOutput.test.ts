import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Production Vite Build Asset Relative Base', () => {
  it('should verify dist/index.html uses relative asset paths and does not use root-absolute /assets/', () => {
    const indexPath = path.join(process.cwd(), 'dist', 'index.html');
    if (!fs.existsSync(indexPath)) {
      // If dist hasn't been built yet in local test run, check vite.config.ts base
      const viteConfig = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf-8');
      expect(viteConfig).toContain("base: './'");
      return;
    }

    const htmlContent = fs.readFileSync(indexPath, 'utf-8');

    // Must NOT contain root-absolute asset paths
    expect(htmlContent).not.toMatch(/src=["']\/assets\//);
    expect(htmlContent).not.toMatch(/href=["']\/assets\//);

    // MUST contain relative asset paths
    expect(htmlContent).toMatch(/(src|href)=["'](\.\/assets\/|assets\/)/);
  });
});
