export function mayCloseMetadataEditor(dirty: boolean, confirmDiscard?: (message: string) => boolean): boolean {
  return !dirty || (confirmDiscard?.('저장하지 않은 책 정보 변경을 버릴까요?') ?? true);
}
