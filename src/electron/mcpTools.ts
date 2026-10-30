import type { IpcHandlerRegistry } from './ipcHandlers';

/**
 * Tools of the local MCP server (#289). Each tool calls the same IPC handlers
 * the desktop UI uses, so validation, the trash fence and output sanitization
 * are unchanged. No tool reads credentials, account tokens or MCP settings.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, registry: IpcHandlerRegistry): Promise<unknown>;
}

/** A tool result the client should treat as a failure. */
export class McpToolError extends Error {
  constructor(public readonly result: unknown) { super('MCP_TOOL_FAILED'); }
}

const str = (description: string) => ({ type: 'string', description });
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const projectIdOnly = { type: 'object', properties: { projectId: str('Project ID, for example PROJ-1A2B3C4D.') }, required: ['projectId'], additionalProperties: false };

const text = (args: Record<string, unknown>, key: string, required = true): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new McpToolError({ success: false, errorCode: 'INVALID_INPUT', error: `${key} is required.` });
    return undefined;
  }
  if (typeof value !== 'string') throw new McpToolError({ success: false, errorCode: 'INVALID_INPUT', error: `${key} must be a string.` });
  return value;
};
const list = (args: Record<string, unknown>, key: string): string[] | undefined => {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new McpToolError({ success: false, errorCode: 'INVALID_INPUT', error: `${key} must be a list of strings.` });
  }
  return value;
};

/** A handler reply of `{ success: false }` (or `false`, `null`) is a tool failure, reported as such. */
const expectSuccess = (reply: unknown): unknown => {
  if (reply === false || reply === null || reply === undefined) throw new McpToolError({ success: false, errorCode: 'NOT_FOUND_OR_REFUSED' });
  if (typeof reply === 'object' && (reply as { success?: unknown }).success === false) throw new McpToolError(reply);
  return reply;
};

const asArray = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value as Record<string, unknown>[] : []);

const transition = (projectId: string, trigger: string, registry: IpcHandlerRegistry) =>
  registry.invoke('project:transition', { projectId, trigger }).then(expectSuccess);

const phaseOf = async (projectId: string, registry: IpcHandlerRegistry) => {
  const reply = await registry.invoke('automation:status') as { success?: boolean; status?: { active?: boolean; projects?: Array<Record<string, unknown>> } };
  return reply?.success ? reply.status?.projects?.find((entry) => entry.projectId === projectId) ?? null : null;
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'get_overview',
    description: 'List every project with its status and automation phase, and the configured agents (Manager, coders, reviewers). Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, registry) {
      const projects = asArray(await registry.invoke('project:list'));
      const status = await registry.invoke('automation:status') as { success?: boolean; status?: { active?: boolean; projects?: Array<Record<string, unknown>> } };
      const phases = new Map((status?.status?.projects ?? []).map((entry) => [entry.projectId, entry]));
      return {
        automationActive: status?.status?.active ?? null,
        projects: projects.map((project) => ({
          id: project.id, name: project.name, status: project.status, repositoryPath: project.repository_path,
          defaultBranch: project.default_branch, completedAt: project.completed_at ?? null, automation: phases.get(project.id) ?? null,
        })),
        agents: await registry.invoke('agents:roster'),
      };
    },
  },
  {
    name: 'get_project',
    description: 'One project in detail: plan (contract), tasks with state and progress, automation phase, Manager mode and proposals, test command, reviewed work and whether it is integrated automatically.',
    inputSchema: projectIdOnly,
    async run(args, registry) {
      const projectId = text(args, 'projectId')!;
      const project = expectSuccess(await registry.invoke('project:get', { projectId }));
      const tasks = asArray(await registry.invoke('task:list', { projectId })).map((task) => ({
        id: task.id, title: task.title, state: task.state, progressPercent: task.progress_cache_percent, revision: task.revision_count,
        priority: task.priority, risk: task.risk,
      }));
      return {
        project,
        tasks,
        automation: await phaseOf(projectId, registry),
        manager: await registry.invoke('automation:managerDecisions', { projectId }),
        verificationCommands: await registry.invoke('verification:getCommands', { projectId }),
        reviewedWork: await registry.invoke('integration:list', { projectId }),
        autoIntegrate: await registry.invoke('integration:getAuto', { projectId }),
      };
    },
  },
  {
    name: 'create_project',
    description: 'Create a project for an existing local Git repository. The path gets the same checks as the folder picker in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Project name (at most 100 characters).'),
        repositoryPath: str('Absolute path of the Git working tree, for example D:/Projects/my-app.'),
        description: str('Optional short description.'),
        defaultBranch: str('Default branch; "main" when omitted.'),
      },
      required: ['name', 'repositoryPath'],
      additionalProperties: false,
    },
    async run(args, registry) {
      const selection = expectSuccess(await registry.selectRepositoryPath(text(args, 'repositoryPath')!)) as { selectionId: string };
      return expectSuccess(await registry.invoke('project:create', {
        name: text(args, 'name'), description: text(args, 'description', false) ?? '',
        repositorySelectionId: selection.selectionId, defaultBranch: text(args, 'defaultBranch', false) ?? 'main',
      }));
    },
  },
  {
    name: 'set_project_plan',
    description: 'Save the project plan (contract). The Manager agent later splits it into tasks. Each list item is one line.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: str('Project ID.'),
        goal: str('What the project must achieve.'),
        business_context: str('Optional background.'),
        acceptance_criteria: strings('How to tell it works, one check per item.'),
        testing_requirements: strings('Tests that must exist or pass.'),
        non_goals: strings('Out of scope.'),
        owner_policies: strings('Rules for the agents, for example "Do not edit run-tests.js".'),
        technical_constraints: strings('Technical constraints.'),
        architecture_constraints: strings('Architecture constraints.'),
        security_requirements: strings('Security requirements.'),
        definition_of_done: strings('Definition of done.'),
      },
      required: ['projectId', 'goal'],
      additionalProperties: false,
    },
    async run(args, registry) {
      const contract: Record<string, unknown> = { goal: text(args, 'goal') };
      const businessContext = text(args, 'business_context', false);
      if (businessContext) contract.business_context = businessContext;
      for (const key of ['acceptance_criteria', 'testing_requirements', 'non_goals', 'owner_policies', 'technical_constraints',
        'architecture_constraints', 'security_requirements', 'definition_of_done']) {
        const items = list(args, key);
        if (items) contract[key] = items;
      }
      return expectSuccess(await registry.invoke('project:importContract', { projectId: text(args, 'projectId'), contract }));
    },
  },
  {
    name: 'approve_plan',
    description: 'Approve the saved plan so the project can start.',
    inputSchema: projectIdOnly,
    run: (args, registry) => transition(text(args, 'projectId')!, 'PLAN_APPROVED', registry),
  },
  {
    name: 'set_test_command',
    description: 'Set and approve the command Agent Forge runs to verify every coder change, for example "node run-tests.js" or "npm test". It runs with the owner\'s OS permissions inside the project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), command: str('The test command line.') },
      required: ['projectId', 'command'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('verification:saveCommands', { projectId: text(args, 'projectId'), commands: { TEST: text(args, 'command') } }));
    },
  },
  {
    name: 'configure_automation',
    description: 'Manager mode ("AUTO": the Manager agent decides; "APPROVE": its proposals wait for approval) and automatic integration of reviewed code into the default branch (never pushed).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: str('Project ID.'),
        managerMode: { type: 'string', enum: ['AUTO', 'APPROVE'], description: 'Manager mode.' },
        autoIntegrate: { type: 'boolean', description: 'Integrate reviewed work into the default branch automatically.' },
        parallelTasks: { type: 'integer', minimum: 1, maximum: 10, description: 'How many tasks coders work on at once (1 = one after another).' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    async run(args, registry) {
      const projectId = text(args, 'projectId')!;
      const result: Record<string, unknown> = {};
      if (args.managerMode !== undefined) result.managerMode = expectSuccess(await registry.invoke('automation:setManagerMode', { projectId, mode: args.managerMode }));
      if (args.autoIntegrate !== undefined) result.autoIntegrate = expectSuccess(await registry.invoke('integration:setAuto', { projectId, enabled: args.autoIntegrate }));
      if (args.parallelTasks !== undefined) result.parallelTasks = expectSuccess(await registry.invoke('automation:setParallelTasks', { projectId, parallelTasks: args.parallelTasks }));
      return result;
    },
  },
  {
    name: 'start_project',
    description: 'Start an approved project: the Manager plans, coders work, tests run and reviewers check, automatically.',
    inputSchema: projectIdOnly,
    run: (args, registry) => transition(text(args, 'projectId')!, 'START_PROJECT', registry),
  },
  {
    name: 'pause_project',
    description: 'Pause a running project; no new work is dispatched.',
    inputSchema: projectIdOnly,
    run: (args, registry) => transition(text(args, 'projectId')!, 'PAUSE', registry),
  },
  {
    name: 'resume_project',
    description: 'Resume a paused or stopped project.',
    inputSchema: projectIdOnly,
    async run(args, registry) { return expectSuccess(await registry.invoke('control:resume', { projectId: text(args, 'projectId') })); },
  },
  {
    name: 'add_task',
    description: 'Add one task to a project by hand (the Manager normally creates tasks from the plan).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: str('Project ID.'),
        title: str('Short task title.'),
        description: str('What to do.'),
        acceptanceCriteria: strings('How to tell the task is done.'),
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      },
      required: ['projectId', 'title'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('task:create', {
        projectId: text(args, 'projectId'), title: text(args, 'title'), description: text(args, 'description', false) ?? null,
        acceptanceCriteria: list(args, 'acceptanceCriteria') ?? [], priority: args.priority, risk: args.risk,
      }));
    },
  },
  {
    name: 'list_events',
    description: 'The latest project events, newest last: planning, coder runs, test results, reviews, integration, completion.',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many (default 30).' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    async run(args, registry) {
      const limit = typeof args.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(args.limit))) : 30;
      const events = asArray(await registry.invoke('events:list', { projectId: text(args, 'projectId') }))
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      return events.slice(-limit).map((event) => ({ at: event.timestamp, type: event.type, taskId: event.task_id ?? null, summary: event.summary }));
    },
  },
  {
    name: 'integrate_reviewed_work',
    description: 'Integrate one task\'s reviewed work into the default branch now (fast-forward or a conflict-free merge; never pushed).',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), taskId: str('Task ID.') },
      required: ['projectId', 'taskId'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('integration:merge', { projectId: text(args, 'projectId'), taskId: text(args, 'taskId') }));
    },
  },
  {
    name: 'configure_verification',
    description: 'Project test environment (#336): installDependencies runs npm ci for the locked dependencies before tests (into a shared folder beside the worktrees); env adds plain variables such as tool paths (e.g. VIDFLOW_FFMPEG). Credential-like and process-steering names are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: str('Project ID.'),
        installDependencies: { type: 'boolean' },
        testTimeoutSeconds: { type: 'integer', minimum: 10, maximum: 600, description: 'How long one test run may take (default 120).' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Variable name to value; replaces the whole set.' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('verification:setEnvironment', {
        projectId: text(args, 'projectId'),
        ...(args.installDependencies !== undefined ? { installDependencies: args.installDependencies } : {}),
        ...(args.testTimeoutSeconds !== undefined ? { testTimeoutSeconds: args.testTimeoutSeconds } : {}),
        ...(args.env !== undefined ? { env: args.env } : {}),
      }));
    },
  },
  {
    name: 'retry_task',
    description: 'Retry a task in NEEDS_HUMAN (it used all its revisions) with 3 more revisions, a BLOCKED task, or a CODING task whose coder runs all failed (automation phase FAILED); the Manager first reads why the last revision failed, and the optional owner note (#364), e.g. "package.json now has the scripts the coder asked for".',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), taskId: str('Task ID.'), note: str('Optional note to the Manager: what the owner changed or decided (at most 2000 characters).') },
      required: ['projectId', 'taskId'],
      additionalProperties: false,
    },
    async run(args, registry) {
      const note = text(args, 'note', false);
      return expectSuccess(await registry.invoke('task:retry', { projectId: text(args, 'projectId'), taskId: text(args, 'taskId'), ...(note ? { note } : {}) }));
    },
  },
  {
    name: 'get_task_context',
    description: "The repository paths a task's coder sees and may change (empty: the project's top-level entries).",
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), taskId: str('Task ID.') },
      required: ['projectId', 'taskId'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('task:getContextPaths', { projectId: text(args, 'projectId'), taskId: text(args, 'taskId') }));
    },
  },
  {
    name: 'set_task_context',
    description: "Set the repository paths a task's coder sees and may change, e.g. to add a caller or test it must keep working (#324). Paths are checked like planned context paths; the whole list is replaced.",
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), taskId: str('Task ID.'), paths: strings('Repository-relative paths.') },
      required: ['projectId', 'taskId', 'paths'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('task:setContextPaths', {
        projectId: text(args, 'projectId'), taskId: text(args, 'taskId'), paths: list(args, 'paths') ?? [],
      }));
    },
  },
  {
    name: 'get_task_dependencies',
    description: 'The task IDs of the same project whose code a task needs; it starts only after they are done (and integrated when automatic integration is on).',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), taskId: str('Task ID.') },
      required: ['projectId', 'taskId'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('task:getDependencies', { projectId: text(args, 'projectId'), taskId: text(args, 'taskId') }));
    },
  },
  {
    name: 'set_task_dependencies',
    description: 'Set the task IDs of the same project whose code a task needs (#362), so independent tasks can run in parallel. The whole list is replaced; a cycle is refused.',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), taskId: str('Task ID.'), dependsOn: strings('Task IDs of the same project.') },
      required: ['projectId', 'taskId', 'dependsOn'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('task:setDependencies', {
        projectId: text(args, 'projectId'), taskId: text(args, 'taskId'), dependsOn: list(args, 'dependsOn') ?? [],
      }));
    },
  },
  {
    name: 'decide_manager_proposal',
    description: 'Approve or reject a Manager proposal waiting in APPROVE mode (eventId from get_project → manager.proposals).',
    inputSchema: {
      type: 'object',
      properties: { projectId: str('Project ID.'), eventId: str('Proposal event ID.'), approve: { type: 'boolean' } },
      required: ['projectId', 'eventId', 'approve'],
      additionalProperties: false,
    },
    async run(args, registry) {
      return expectSuccess(await registry.invoke('automation:decideManagerProposal', { projectId: text(args, 'projectId'), eventId: text(args, 'eventId'), approve: args.approve }));
    },
  },
];

/** Shown to the connected AI on `initialize`: the usual flow. */
export const MCP_INSTRUCTIONS = [
  'Agent Forge runs software projects with its own agents (a Manager plans, CLI coders implement, tests run, reviewers check, reviewed code is integrated).',
  'Typical flow for new work: create_project → set_project_plan → approve_plan → set_test_command → configure_automation (managerMode AUTO, autoIntegrate true) → start_project.',
  'Then follow progress with get_project and list_events until the project status is COMPLETED, and report back to the owner.',
  'Agent Forge never pushes to a remote. Reviewed code lands only on the local default branch.',
].join('\n');
