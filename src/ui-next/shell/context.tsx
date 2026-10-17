import { createContext } from 'react';
import type { UiNextNavigation } from './contract';

export const UiNextNavigationContext = createContext<UiNextNavigation | undefined>(undefined);
