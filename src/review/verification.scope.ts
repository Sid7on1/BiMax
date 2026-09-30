// The rule lives in ./review.verdict, which imports nothing, so the protocol can hand the window the same definition
// (UI fix list item 41). This module keeps its name for the engine code that imports it.
export { requiresBuildVerification } from './review.verdict';
