import { useState } from 'react';

import { type ReaderChromeProps } from '../features/reader/reader-chrome-contract';
import { UiNextReaderChrome } from './reader/UiNextReaderChrome';
import { useReaderOverflowBack } from './use-reader-overflow-back';

/** Reader overflow keeps its own history-backed dismissal. */
export function ReaderChrome(props: ReaderChromeProps) {
  const [Chrome] = useState(() => UiNextReaderChrome);
  useReaderOverflowBack(props.overflowOpen);
  return <Chrome {...props} />;
}
