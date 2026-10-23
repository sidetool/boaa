export type WorkView = 'grid' | 'compact' | 'list' | 'text';
export const workViews = [
  ['grid', '표지'],
  ['compact', '작은 표지'],
  ['list', '목록'],
  ['text', '텍스트 목록'],
] as const;
export const isWorkView = (value: unknown): value is WorkView => workViews.some(([mode]) => mode === value);
export const isCoverView = (value: WorkView) => value === 'grid' || value === 'compact';
