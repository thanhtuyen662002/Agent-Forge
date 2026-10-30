import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark } from '../src/ui/components/BrandMark';

/** #345: the Agent Forge logo in the app, the favicon and the Windows installer icon. */
describe('Agent Forge brand mark', () => {
  it('renders an accessible logo whose gradient id is unique per instance', () => {
    const markup = renderToStaticMarkup(<><BrandMark className="w-7 h-7" /><BrandMark /></>);
    expect(markup.match(/role="img" aria-label="Agent Forge"/g)).toHaveLength(2);
    const ids = [...markup.matchAll(/linearGradient id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(markup).toContain(`fill="url(#${id})"`);
  });

  it('ships the same mark as favicon and as the multi-size installer icon', () => {
    const root = path.resolve(__dirname, '..');
    const favicon = fs.readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8');
    const component = fs.readFileSync(path.join(root, 'src', 'ui', 'components', 'BrandMark.tsx'), 'utf8');
    for (const shape of favicon.match(/ d="([^"]+)"/g) ?? []) expect(component).toContain(shape.trim());
    expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toContain('href="./favicon.svg"');
    expect(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')).toMatch(/^\s+icon: build\/icon\.ico$/m);

    // ICO header: reserved 0, type 1, then one 16-byte entry per size (width 0 means 256).
    const ico = fs.readFileSync(path.join(root, 'build', 'icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16] || 256).sort((a, b) => a - b);
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });
});
