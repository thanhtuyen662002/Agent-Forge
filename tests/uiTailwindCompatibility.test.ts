import fs from 'node:fs';
import path from 'node:path';
import postcss, { type AnyNode, type Root } from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { beforeAll, describe, expect, it } from 'vitest';

describe('compiled owner interface CSS after the dependency security upgrade', () => {
  let css: Root;
  beforeAll(async () => {
    const file = path.resolve('src/ui/index.css');
    css = (await postcss([tailwind({ base: process.cwd(), optimize: false })])
      .process(fs.readFileSync(file, 'utf8'), { from: file })).root;
  });
  function declarations(selector: string): Record<string, string> {
    const values: Record<string, string> = {};
    css.walkRules(rule => {
      if (rule.selector === selector) rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    });
    return values;
  }

  it('emits existing custom surfaces and authority action colors', () => {
    expect(declarations('.bg-surface')['background-color']).toBe('#111726');
    expect(declarations('.bg-surface-card')['background-color']).toBe('#161f33');
    expect(declarations('.text-forge-amber').color).toBe('#f59e0b');
    expect(declarations('.text-forge-emerald').color).toBe('#10b981');
    expect(declarations('.border-surface-border')['border-color']).toBe('#1f2b48');
  });

  it('preserves the existing small shadow and modal blur sizes', () => {
    expect(declarations('.shadow-sm')['--tw-shadow']).toContain('0 1px 2px 0');
    expect(declarations('.backdrop-blur-sm')['--tw-backdrop-blur']).toBe('blur(4px)');
  });

  it('retains the unlayered visible focus outline and clipping-safe button offset', () => {
    let outline: string | undefined;
    let layered = false;
    css.walkRules(rule => {
      if (rule.selector.includes('button:focus-visible') && rule.selector.includes('input:focus-visible')) {
        rule.walkDecls('outline', declaration => { outline = declaration.value; });
        let parent: AnyNode | undefined = rule.parent;
        while (parent) {
          if (parent.type === 'atrule' && parent.name === 'layer') layered = true;
          parent = parent.parent;
        }
      }
    });
    expect(outline).toBe('2px solid #22d3ee');
    expect(layered).toBe(false);
    expect(declarations('button:focus-visible')['outline-offset']).toBe('-2px');
  });

  it('emits the existing horizontal Kanban scroll and responsive dashboard grid', () => {
    expect(declarations('.overflow-x-auto')['overflow-x']).toBe('auto');
    expect(declarations('.min-w-\\[240px\\]')['min-width']).toBe('240px');
    expect(declarations('.lg\\:grid-cols-4')['grid-template-columns']).toBe('repeat(4, minmax(0, 1fr))');
  });
});
