import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThinkingIndicator } from '../renderer/src/components/ThinkingIndicator';
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../renderer/src', file), 'utf8');
const css = () => read('styles.css');
test('working is readable, preserves real retry/reasoning text, and never scrambles or rotates', () => {
  const html = renderToStaticMarkup(<ThinkingIndicator thinking="Look at the current files first." status="Provider retry in 2s" />);
  expect(html).toContain('Working'); expect(html).toContain('Provider retry in 2s'); expect(html).toContain('Look at the current files first.');
  const source = read('components/ThinkingIndicator.tsx');
  expect(source).not.toMatch(/Math.random|requestAnimationFrame|nextVerb|animate-soft-blink/);
  expect(css().match(/\.thinking-verb \{([^}]*)\}/)![1]).not.toMatch(/animation|transparent|gradient/);
});
test('home choices and history arrive together, and ordinary hover does not travel', () => {
  const body = css().match(/\.workspace-starter \{([^}]*)\}/)![1];
  expect(body).not.toMatch(/animation:|box-shadow:/);
  expect(css().match(/\.workspace-starter:hover \{([^}]*)\}/)![1]).not.toMatch(/transform|box-shadow/);
  expect(css().match(/\.pressable::after \{([^}]*)\}/)![1]).toContain('display: none');
  for (const file of ['HomeView', 'GalleryView']) expect(read(`components/${file}.tsx`)).not.toMatch(/animationDelay|anim-fade-up|hover:-translate/);
});
test('dense history leads with the task title before its age or metadata', () => {
  const source = read('components/GalleryView.tsx');
  expect(source.indexOf('{m.title &&')).toBeLessThan(source.indexOf('{relTime(m.startedAt)}'));
});
test('ordinary enabled controls get an immediate static acknowledgement that preserves ink and fill', () => {
  const body = css().match(/button:enabled:active,[\s\S]*?\{([^}]*)\}/)![1];
  expect(body).toContain('outline: 1px solid currentColor');
  expect(body).not.toMatch(/opacity|filter|background|color:|animation|transition/);
});
