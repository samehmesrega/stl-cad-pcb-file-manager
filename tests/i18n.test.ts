import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { arabicMessages, translate } from '../shared/i18n.ts';

const ARABIC_LETTER = /[؀-ۿ]/;
const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join();

test('i18n: every message has an Arabic translation with the same placeholders', () => {
  for (const [english, arabic] of arabicMessages()) {
    assert.ok(!ARABIC_LETTER.test(english), `key is not English: ${english}`);
    assert.ok(ARABIC_LETTER.test(arabic) || arabic === english, `not translated: ${english}`);
    assert.equal(placeholders(arabic), placeholders(english), english);
  }
});

test('i18n: values go in, and text with no translation stays as it is', () => {
  assert.equal(translate('en', '{n} designs', { n: 3 }), '3 designs');
  assert.equal(translate('ar', '{n} designs', { n: 3 }), '3 تصميم');
  assert.equal(translate('ar', 'ERROR: from a tool'), 'ERROR: from a tool');
});

test('i18n: all interface text lives in the translation table', () => {
  // The search normalizer and the language button are the only code that needs Arabic letters.
  const allowed = new Map([
    ['shared/formats.ts', /arabic: '|ARABIC_DIGITS|\.replace\(/],
    ['src/components/ui.tsx', /'العربية'/],
    ['src/App.tsx', /isRtl \? '، '/],
  ]);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  for (const file of ['server', 'shared', 'src', 'electron'].flatMap(walk)) {
    const name = file.replace(/\\/g, '/');
    if (name === 'shared/i18n.ts') continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (ARABIC_LETTER.test(line)) assert.ok(allowed.get(name)?.test(line), `${name}:${index + 1}: ${line.trim()}`);
    });
  }
});
