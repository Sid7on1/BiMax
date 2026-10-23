import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileUrl, taskView, TaskViewCard } from '../renderer/src/components/TaskViews';

/** Backlog FL8: the three views a task can open, as the ⌘2 bar and the approval popup show them. */

const body = (view: object): string => JSON.stringify({ bimaxView: view });

test('only a question carrying a known view is shown as one', () => {
  expect(taskView(body({ view: 'photos', title: 't', files: ['/r/a.jpg'], pick: 'some' }))).toMatchObject({ view: 'photos' });
  expect(taskView(body({ view: 'chart' }))).toBeNull();
  expect(taskView('Allow? Write a.txt')).toBeNull();
  expect(taskView('{"bimaxView": broken')).toBeNull();
  expect(taskView(undefined)).toBeNull();
  // A view is the whole body, as the tool writes it — never a key buried in some other JSON.
  expect(taskView(JSON.stringify({ note: 'x', bimaxView: { view: 'photos', title: 't', files: [], pick: 'some' } }))).toBeNull();
});

test('a picture’s address survives # and ? in its name', () => {
  expect(fileUrl('/Users/me/Photos/Trip #2/IMG?1.jpg')).toBe('file:///Users/me/Photos/Trip%20%232/IMG%3F1.jpg');
});

test('each view shows what there is to decide', () => {
  const sheet = renderToStaticMarkup(<TaskViewCard view={{ view: 'photos', title: 'Pick for the album', files: ['/r/a b.jpg', '/r/c.jpg'], pick: 'some' }} onReply={() => undefined} />);
  expect(sheet).toContain('Pick for the album');
  expect(sheet).toContain('src="file:///r/a%20b.jpg"');
  expect(sheet).toContain('Use 0 picked');
  const match = renderToStaticMarkup(<TaskViewCard view={{ view: 'match', title: 'Match', left: ['Bank 12.00'], right: ['Inv A', 'Inv B'], pairs: [{ left: 0, right: 1 }] }} onReply={() => undefined} />);
  expect(match).toContain('<option value="1" selected="">Inv B</option>');
  expect(match).toContain('(no match)');
  const names = renderToStaticMarkup(<TaskViewCard view={{ view: 'names', title: 'Names', items: [{ path: '/r/scan1.pdf', name: '2026-09-01 Cafe.pdf' }] }} onReply={() => undefined} />);
  expect(names).toContain('value="2026-09-01 Cafe.pdf"');
  expect(names).toContain('scan1.pdf');
});
