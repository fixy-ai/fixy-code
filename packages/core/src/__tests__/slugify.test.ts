import { describe, expect, it } from 'vitest';
import { slugify } from '../slugify.js';

describe('slugify — basic ASCII', () => {
  it('lowercases the input', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('removes punctuation', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('collapses multiple whitespace characters into a single hyphen', () => {
    expect(slugify('foo   bar')).toBe('foo-bar');
  });

  it('preserves digits', () => {
    expect(slugify('foo 123 bar')).toBe('foo-123-bar');
  });

  it('collapses repeated non-alphanumeric chars into one hyphen', () => {
    expect(slugify('a---b')).toBe('a-b');
  });

  it('trims leading hyphens', () => {
    expect(slugify('---hello')).toBe('hello');
  });

  it('trims trailing hyphens', () => {
    expect(slugify('hello---')).toBe('hello');
  });

  it('trims both leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('returns empty string when only punctuation is given', () => {
    expect(slugify('!!!')).toBe('');
  });

  it('returns empty string for an empty input', () => {
    expect(slugify('')).toBe('');
  });

  it('removes apostrophes so contractions collapse without a separator', () => {
    expect(slugify("don't stop")).toBe('dont-stop');
  });

  it('handles a slug that is already clean', () => {
    expect(slugify('hello-world')).toBe('hello-world');
  });

  it('handles input that is purely digits', () => {
    expect(slugify('123')).toBe('123');
  });

  it('output contains only lowercase letters, digits, and hyphens', () => {
    const result = slugify('Hello, World! 123 -- foo@bar.baz');
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('slugify — diacritics and transliteration map', () => {
  it('strips diacritics via NFKD decomposition', () => {
    expect(slugify('naïve café')).toBe('naive-cafe');
  });

  it('handles "Crème brûlée"', () => {
    expect(slugify('Crème brûlée')).toBe('creme-brulee');
  });

  it('transliterates ß → ss ("Straße")', () => {
    expect(slugify('Straße')).toBe('strasse');
  });

  it('transliterates Æ → ae and Œ → oe ("Æther Œuvre")', () => {
    expect(slugify('Æther Œuvre')).toBe('aether-oeuvre');
  });

  it('transliterates æ → ae', () => {
    expect(slugify('æon')).toBe('aeon');
  });

  it('transliterates œ → oe', () => {
    expect(slugify('œuvre')).toBe('oeuvre');
  });

  it('transliterates ø / Ø → o', () => {
    expect(slugify('ø')).toBe('o');
    expect(slugify('Ø')).toBe('o');
  });

  it('transliterates đ / Đ → d', () => {
    expect(slugify('đuro')).toBe('duro');
    expect(slugify('Đuro')).toBe('duro');
  });

  it('transliterates ð / Ð → d', () => {
    expect(slugify('ðór')).toBe('dor');
  });

  it('transliterates þ / Þ → th', () => {
    expect(slugify('þorn')).toBe('thorn');
    expect(slugify('Þorn')).toBe('thorn');
  });

  it('transliterates ł / Ł → l', () => {
    expect(slugify('Łódź')).toBe('lodz');
  });

  it('returns empty string when only non-slug-safe unicode chars remain', () => {
    // Characters with no transliteration and no ASCII base (e.g. CJK)
    expect(slugify('日本語')).toBe('');
  });

  it('output is strictly ASCII for transliterated input', () => {
    const result = slugify('Crème brûlée Straße Æther Œuvre');
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('slugify — separators, underscores, slashes', () => {
  it('converts underscores to hyphens', () => {
    expect(slugify('foo_bar')).toBe('foo-bar');
  });

  it('converts multiple underscores to a single hyphen', () => {
    expect(slugify('foo___bar')).toBe('foo-bar');
  });

  it('converts forward slashes to hyphens', () => {
    expect(slugify('foo/bar')).toBe('foo-bar');
  });

  it('converts backslashes to hyphens', () => {
    expect(slugify('foo\\bar')).toBe('foo-bar');
  });

  it('converts dots used as separators to hyphens', () => {
    expect(slugify('foo.bar.baz')).toBe('foo-bar-baz');
  });

  it('converts pipes to hyphens', () => {
    expect(slugify('foo|bar')).toBe('foo-bar');
  });

  it('converts colons to hyphens', () => {
    expect(slugify('foo:bar')).toBe('foo-bar');
  });

  it('collapses mixed separators (slash + underscore + space) into one hyphen', () => {
    expect(slugify('foo / _bar')).toBe('foo-bar');
  });

  it('preserves an already-clean hyphenated slug unchanged', () => {
    expect(slugify('already-clean-slug')).toBe('already-clean-slug');
  });

  it('preserves hyphenated slug with numbers', () => {
    expect(slugify('step-1-of-3')).toBe('step-1-of-3');
  });
});

describe('slugify — apostrophes', () => {
  it('removes straight apostrophe in contraction without inserting a hyphen', () => {
    expect(slugify("it's")).toBe('its');
  });

  it('removes Unicode left single quotation mark (U+2018)', () => {
    expect(slugify('\u2018hello\u2019')).toBe('hello');
  });

  it('removes Unicode right single quotation mark (U+2019)', () => {
    expect(slugify("won\u2019t")).toBe('wont');
  });

  it('removes modifier letter apostrophe (U+02BC)', () => {
    expect(slugify('o\u02BCclock')).toBe('oclock');
  });

  it('handles multiple apostrophes in a row without producing hyphens', () => {
    expect(slugify("''hello''")).toBe('hello');
  });
});

describe('slugify — emojis', () => {
  it('strips a leading emoji', () => {
    expect(slugify('🚀 launch')).toBe('launch');
  });

  it('strips a trailing emoji', () => {
    expect(slugify('launch 🚀')).toBe('launch');
  });

  it('strips an emoji between words without doubling hyphens', () => {
    expect(slugify('foo 🔥 bar')).toBe('foo-bar');
  });

  it('strips an emoji adjacent to a word without inserting a hyphen', () => {
    expect(slugify('foo🔥bar')).toBe('foobar');
  });

  it('returns empty string when input is only emojis', () => {
    expect(slugify('🚀🔥💡')).toBe('');
  });
});

describe('slugify — edge cases', () => {
  it('returns empty string for an empty input ""', () => {
    expect(slugify('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(slugify('   ')).toBe('');
  });

  it('returns empty string for tab and newline input', () => {
    expect(slugify('\t\n\r')).toBe('');
  });

  it('returns empty string for all-symbol input (mixed punctuation)', () => {
    expect(slugify('!@#$%^&*()')).toBe('');
  });

  it('returns empty string for Cyrillic input with no transliteration', () => {
    expect(slugify('Привет')).toBe('');
  });

  it('returns empty string for Arabic input', () => {
    expect(slugify('مرحبا')).toBe('');
  });

  it('returns empty string for Hebrew input', () => {
    expect(slugify('שלום')).toBe('');
  });

  it('returns empty string for CJK input', () => {
    expect(slugify('日本語')).toBe('');
  });

  it('handles a single ASCII letter', () => {
    expect(slugify('a')).toBe('a');
  });

  it('handles a single digit', () => {
    expect(slugify('9')).toBe('9');
  });
});

describe('slugify — output invariants', () => {
  const cases = [
    'Hello, World!',
    '  leading and trailing  ',
    '---hyphens---',
    'a---b---c',
    'foo / bar \\ baz',
    'foo_bar_baz',
    'Crème brûlée Straße',
    '🚀 rockets 🔥 fire',
    'it\u2019s a test',
    '!!!',
    '',
    '日本語',
    'UPPER CASE INPUT',
    'mixed123Numbers',
  ];

  for (const input of cases) {
    it(`output for "${input}" never has repeated, leading, or trailing hyphens`, () => {
      const result = slugify(input);
      if (result.length > 0) {
        expect(result).not.toMatch(/^-/);
        expect(result).not.toMatch(/-$/);
        expect(result).not.toMatch(/--/);
        expect(result).toMatch(/^[a-z0-9-]+$/);
      } else {
        expect(result).toBe('');
      }
    });
  }

  it('valid slug input is idempotent (slugify(slugify(x)) === slugify(x))', () => {
    const inputs = ['Hello World', 'foo_bar', 'Crème brûlée', '🚀 launch', "don't stop"];
    for (const input of inputs) {
      const once = slugify(input);
      const twice = slugify(once);
      expect(twice).toBe(once);
    }
  });
});
