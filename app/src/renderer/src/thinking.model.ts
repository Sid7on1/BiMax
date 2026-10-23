/**
 * The pure half of the thinking row: which word it shows, and how much of the reasoning it shows.
 *
 * The words are the spinner verbs Claude Code cycles through while it works, taken from the public
 * lists of them (codingcocoon.com, "Every Spinner Verb in Claude Code"; deepakness.com, "List of 187
 * Claude spinner verbs"; both read 2026-09-13), minus the one that is Claude's own name and a few that
 * read as a joke at the expense of someone waiting on real work. They say "alive, and working" without
 * claiming a specific activity the engine is not doing.
 */
export const THINKING_VERBS = [
  'Accomplishing', 'Architecting', 'Baking', 'Brewing', 'Calculating', 'Cascading', 'Channeling',
  'Choreographing', 'Churning', 'Coalescing', 'Cogitating', 'Composing', 'Computing', 'Concocting',
  'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing',
  'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Doodling', 'Elucidating', 'Envisioning',
  'Fermenting', 'Finagling', 'Forging', 'Forming', 'Generating', 'Germinating', 'Hatching', 'Ideating',
  'Imagining', 'Improvising', 'Incubating', 'Inferring', 'Infusing', 'Kneading', 'Manifesting',
  'Marinating', 'Meandering', 'Metamorphosing', 'Moseying', 'Mulling', 'Musing', 'Mustering', 'Noodling',
  'Orbiting', 'Orchestrating', 'Percolating', 'Perusing', 'Philosophising', 'Pondering', 'Processing',
  'Puttering', 'Puzzling', 'Recombobulating', 'Reticulating', 'Ruminating', 'Simmering', 'Sketching',
  'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Synthesizing',
  'Tempering', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Unravelling', 'Vibing', 'Wandering',
  'Whirring', 'Whisking', 'Working', 'Wrangling', 'Zigzagging',
] as const;

/** A different verb from the one on screen, so every swap is visible. */
export function nextVerb(current: string, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pick = THINKING_VERBS[Math.floor(random() * THINKING_VERBS.length) % THINKING_VERBS.length];
    if (pick !== current) return pick;
  }
  const index = THINKING_VERBS.indexOf(current as (typeof THINKING_VERBS)[number]);
  return THINKING_VERBS[(index + 1) % THINKING_VERBS.length];
}

/**
 * True when the reasoning stream has degenerated into a token loop.
 *
 * This is the case that once got the reasoning hidden altogether: a reasoning model that loops
 * ("ellsellsells…") rendered the loop straight into the transcript as if it were output. Detecting the
 * loop lets the stream stay visible for every run that is not doing that.
 */
export function isDegenerate(text: string): boolean {
  const tail = text.slice(-240);
  if (tail.length < 60) return false;
  for (let size = 1; size <= 16; size++) {
    const unit = tail.slice(-size);
    let repeats = 0;
    for (let at = tail.length - size; at >= 0 && tail.slice(at, at + size) === unit; at -= size) repeats++;
    if (repeats >= 6 && repeats * size >= 60) return true;
  }
  return false;
}

/** The end of the reasoning stream, trimmed to a readable window that starts on a word boundary. */
export function reasoningTail(text: string, maxChars = 360): string {
  const clean = text.replace(/[ \t]+\n/g, '\n').trimEnd();
  if (clean.length <= maxChars) return clean.trimStart();
  const cut = clean.slice(-maxChars);
  const boundary = cut.search(/\s/);
  return `…${boundary >= 0 && boundary < 40 ? cut.slice(boundary + 1) : cut}`;
}
