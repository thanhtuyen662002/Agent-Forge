import type { ProjectContract } from '../core/types/domain';

/** List fields of ProjectContract, in the order the guided form shows them. */
export const CONTRACT_LIST_FIELDS = [
  'acceptance_criteria',
  'definition_of_done',
  'testing_requirements',
  'technical_constraints',
  'architecture_constraints',
  'security_requirements',
  'non_goals',
  'owner_policies',
] as const;
export type ContractListField = (typeof CONTRACT_LIST_FIELDS)[number];

export type ContractFormState = { goal: string; business_context: string } & Record<ContractListField, string>;

export function emptyContractForm(): ContractFormState {
  const form = { goal: '', business_context: '' } as ContractFormState;
  for (const field of CONTRACT_LIST_FIELDS) form[field] = '';
  return form;
}

/**
 * One item per line. Common list markers ("- ", "* ", "• ", "1. ", "2) ")
 * are removed so text pasted from a document or chat works unchanged.
 */
export function linesToItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•]|\d{1,3}[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
}

export function contractFromForm(form: ContractFormState): ProjectContract {
  const contract = {
    goal: form.goal.trim(),
    ...(form.business_context.trim() ? { business_context: form.business_context.trim() } : {}),
  } as ProjectContract;
  for (const field of CONTRACT_LIST_FIELDS) contract[field] = linesToItems(form[field]);
  return contract;
}

export function formFromContract(contract: ProjectContract | null | undefined): ContractFormState {
  const form = emptyContractForm();
  if (!contract) return form;
  form.goal = typeof contract.goal === 'string' ? contract.goal : '';
  form.business_context = typeof contract.business_context === 'string' ? contract.business_context : '';
  for (const field of CONTRACT_LIST_FIELDS) {
    const items = contract[field];
    form[field] = Array.isArray(items) ? items.filter((item) => typeof item === 'string').join('\n') : '';
  }
  return form;
}

/** Statuses from which the owner may approve the plan (state machine PLAN_APPROVED). */
export function canApprovePlan(status: string | undefined, contract: ProjectContract | null | undefined): boolean {
  return (status === 'DRAFT' || status === 'PLANNING') && Boolean(contract?.goal?.trim());
}
