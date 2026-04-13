const TRANSLITERATION_MAP: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ø: 'o',
  Ø: 'o',
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  þ: 'th',
  Þ: 'th',
  ł: 'l',
  Ł: 'l',
};

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\u0000-\u007F]/g, (ch) => TRANSLITERATION_MAP[ch] ?? '')
    // 1. Convert to lowercase
    .toLowerCase()
    // 2. Remove Unicode combining marks produced by normalization
    .replace(/\p{M}/gu, '')
    // 3. Remove apostrophes so contractions collapse without a separator
    .replace(/['\u2018\u2019\u02bc]/g, '')
    // 4. Replace each contiguous run of non-ASCII-alphanumeric characters with a single hyphen
    .replace(/[^a-z0-9]+/g, '-')
    // 5. Collapse repeated hyphens into one hyphen
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
