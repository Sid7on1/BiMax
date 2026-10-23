import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThinkingIndicator } from '../renderer/src/components/ThinkingIndicator';
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../renderer/src', file), 'utf8');
const css = () => read('styles.css');

// 2026-10-01: batch 16 (items 28/30) removed the rotating words, the welcome entrance and hover lift, the hover shine,
// and added an outline to every pressed button. The owner asked for the words back ("why did it remove those words")
// and for the pre-batch feel; these tests now hold that. The rotating words were the owner's own request (2026-09-13).
test('the working row rotates its words, and still shows the real retry status and reasoning', () => {
  const html = renderToStaticMarkup(<ThinkingIndicator thinking="Look at the current files first." status="Provider retry in 2s" />);
  expect(html).toContain('Provider retry in 2s');
  expect(html).toContain('Look at the current files first.');
  const source = read('components/ThinkingIndicator.tsx');
  expect(source).toMatch(/THINKING_VERBS/);
  expect(source).toMatch(/nextVerb/);
  expect(css().match(/\.thinking-verb \{([^}]*)\}/)![1]).toContain('animation: thinking-shimmer');
});
test('the welcome choices arrive and lift under the pointer, as the owner chose (record 44)', () => {
  expect(css().match(/\.workspace-starter \{([^}]*)\}/)![1]).toContain('animation: workspace-arrive');
  expect(css().match(/\.workspace-starter:hover \{([^}]*)\}/)![1]).toContain('transform: translateY(-4px)');
  expect(css().match(/\.pressable:hover::after \{([^}]*)\}/)![1]).toContain('translateX(125%)');
  expect(read('components/HomeView.tsx')).toMatch(/animationDelay/);
});
test('dense history leads with the task title before its age or metadata', () => {
  const source = read('components/GalleryView.tsx');
  expect(source.indexOf('{m.title &&')).toBeLessThan(source.indexOf('{relTime(m.startedAt)}'));
});
test('a pressed button is not boxed in by an outline', () => {
  expect(css()).not.toMatch(/button:enabled:active[\s\S]{0,200}outline: 1px solid currentColor/);
});
