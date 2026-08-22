/** The irreversible search contract. A receipt is incomplete if any stage is absent or reordered. */
export const MENU_SEARCH_TRANSACTION_STAGES = [
  'open_search',
  'type',
  'reobserve',
  'ground_result',
  'select',
  'verify',
] as const;

export type MenuSearchTransactionStage = typeof MENU_SEARCH_TRANSACTION_STAGES[number];

export function isCompleteMenuSearchTransaction(
  stages: readonly { stage?: unknown; ok?: unknown }[],
): boolean {
  return MENU_SEARCH_TRANSACTION_STAGES.every((stage, index) =>
    stages[index]?.stage === stage && stages[index]?.ok === true);
}

