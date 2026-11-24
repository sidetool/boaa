/** Each ordered slot owns its cancellation signal through download, assembly and import. */
export class DownloadItemSignals {
  private readonly slots = new Map<number, AbortController>();

  signal = (index: number): AbortSignal => {
    let slot = this.slots.get(index);
    if (!slot) {
      slot = new AbortController();
      this.slots.set(index, slot);
    }
    return slot.signal;
  };

  cancel(index: number) {
    this.signal(index);
    this.slots.get(index)!.abort();
  }
}
