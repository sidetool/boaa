import { createContext } from 'react';
import type { HomeAdapterInput } from './model';
import type { SearchData } from '../search/data';
export const HomeDataContext = createContext<
  (Omit<HomeAdapterInput, 'navigation'> & { search?: SearchData }) | undefined
>(undefined);
