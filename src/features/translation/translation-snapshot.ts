import type { ReaderBodyRepository } from '../../repositories/reader-repository';
import type { ReaderScreenModel } from '../reader/reader-screen-contract';
import { translationTextParagraphs, type TranslationParagraph } from '../../translation/contracts';
import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
export async function translationSnapshot(
  repository: ReaderBodyRepository,
  chapter: Pick<ReaderScreenModel['chapter'], 'id' | 'paragraphCount'>,
  signal: AbortSignal,
): Promise<TranslationParagraph[]> {
  const paragraphs: TranslationParagraph[] = [];
  let characters = 0;
  let sourceCount = 0;
  for (let page = 0; page < Math.ceil(chapter.paragraphCount / PARAGRAPHS_PER_PAGE); page++) {
    signal.throwIfAborted();
    const source = await repository.getParagraphPage(chapter.id, page, signal);
    signal.throwIfAborted();
    if (!source) throw new Error('translation_source_changed');
    sourceCount += source.paragraphs.length;
    for (const paragraph of translationTextParagraphs(source.paragraphs)) {
      paragraphs.push(paragraph);
      characters += paragraph.text.length;
      if (characters > 500000 || paragraphs.length > 10000) throw new Error('translation_invalid_settings');
    }
  }
  if (sourceCount !== chapter.paragraphCount) throw new Error('translation_source_changed');
  return paragraphs;
}
