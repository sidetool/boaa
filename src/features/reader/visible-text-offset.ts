/** First visible character in a laid-out paragraph, including a single very long sentence. */
export function visibleTextOffset(length: number, isVisible: (offset: number) => boolean): number {
  let low = 0;
  let high = Math.max(0, length - 1);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (isVisible(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}
