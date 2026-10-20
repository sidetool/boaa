import { createContext } from 'react';
export const ReaderTranslationContext = createContext<ReadonlyMap<string, string> | undefined>(undefined);
