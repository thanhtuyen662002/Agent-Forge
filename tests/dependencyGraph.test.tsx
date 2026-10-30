import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/core/types/domain';
import { I18nProvider } from '../src/ui/context/I18nContext';
import { DependencyGraph } from '../src/ui/components/DependencyGraph';
import { layoutDependencyGraph } from '../src/ui/dependencyGraph';

const task = (id: string, state: Task['state'] = 'CODING') => ({ id, title: `Task ${id}`, state } as Task);
const ids = (columns: Task[][]) => columns.map((column) => column.map((entry) => entry.id));

/** #366: the task board shows a project's dependencies as a left-to-right graph. */
describe('dependency graph', () => {
  it('puts each task one column after the deepest task it needs, in plan order', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => task(id));
    const layout = layoutDependencyGraph(tasks, { c: ['a', 'b'], d: ['c'], e: ['a'] });
    expect(ids(layout.columns)).toEqual([['a', 'b'], ['c', 'e'], ['d']]);
    expect(layout.edges).toEqual([{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'a', to: 'e' }]);
    expect(layout.hasDependencies).toBe(true);
  });

  it('leaves out tasks that are not shown and never loops on a cycle', () => {
    const tasks = [task('a'), task('b')];
    const layout = layoutDependencyGraph(tasks, { a: ['b', 'trashed'], b: ['a'] });
    expect(layout.columns.flat()).toHaveLength(2);
    expect(layout.edges.every((edge) => edge.from !== 'trashed')).toBe(true);
  });

  it('reports a project without dependencies', () => {
    const layout = layoutDependencyGraph([task('a'), task('b')], {});
    expect(ids(layout.columns)).toEqual([['a', 'b']]);
    expect(layout.hasDependencies).toBe(false);
  });

  it('renders one node per task, one curve per dependency and the dependencies in each label', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <DependencyGraph tasks={[task('a', 'DONE'), task('b'), task('c', 'PLANNED')]} dependencies={{ c: ['a', 'b'] }} onOpenTask={() => undefined} />
      </I18nProvider>,
    );
    expect(markup.match(/data-task=/g)).toHaveLength(3);
    expect(markup.match(/data-edge=/g)).toHaveLength(2);
    expect(markup).toContain('Task c, ');
    expect(markup).toContain('Task a, Task b');
  });
});
