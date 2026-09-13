import { looksLikePath } from '../renderer/src/path.links';

test('inline code that names a file or folder becomes a link; commands, URLs and code do not', () => {
  for (const path of ['/Users/me/Desktop/DEV', '~/Downloads', './notes.txt', 'Screenshots/a.png', 'api keys/', 'package.json', 'Xcode_16.xip', 'Bimax/src/']) {
    expect([path, looksLikePath(path)]).toEqual([path, true]);
  }
  for (const text of ['npm run build', 'https://example.com/a', 'v1.2', 'a=b', 'rm -rf x/y', 'foo()', '*.png', 'DEV', '']) {
    expect([text, looksLikePath(text)]).toEqual([text, false]);
  }
});
