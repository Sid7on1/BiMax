import { decideSlot, routeToModel, catalogueSlotFor, explainRoute } from '../engine/task.router';
import { ModelEntry } from '../engine/models';

const slot = (prompt: string, attachments?: string[]) => decideSlot(prompt, { attachments }).slot;

describe('vision routing — the axis the weight router did not have', () => {
  it('routes a structurally attached image regardless of what the text says', () => {
    // The hard case: the user drags in a drawing and types four words with no visual signal at all.
    expect(slot('what is this?', ['/scans/PID-4021.png'])).toBe('vision');
  });

  it('treats an attached PDF as vision, because a scan reaches the model as rasterized pages', () => {
    expect(slot('summarise this', ['/reports/inspection-2026-08.pdf'])).toBe('vision');
  });

  it('names the attachment in the reason so the decision can be checked', () => {
    const d = decideSlot('what is this?', { attachments: ['/scans/PID-4021.png'] });
    expect(d.reason).toContain('PID-4021.png');
  });

  it('ignores a non-visual attachment', () => {
    expect(slot('refactor this', ['/src/index.ts'])).toBe('code');
  });

  it('routes on a path written into the prompt when nothing is attached', () => {
    expect(slot('read ./scans/report.jpg and list the findings')).toBe('vision');
  });

  it('routes on a subject that names something which must be seen', () => {
    expect(slot('extract the tag numbers from the scanned P&ID')).toBe('vision');
    expect(slot('what does the handwritten note in the margin say')).toBe('vision');
  });

  it('does not route a described diagram to vision when there is nothing to look at', () => {
    // "explain the architecture diagram in the README" is a text turn. Sending it to a vision
    // model with no image would be strictly worse than the old behaviour.
    expect(slot('explain the architecture diagram in the README')).not.toBe('vision');
  });
});

describe('drafting versus coding — the overlap that decides the headline demo', () => {
  it('routes a document deliverable to draft', () => {
    expect(slot('draft an approval note as a Word document')).toBe('draft');
    expect(slot('prepare a board presentation as a pptx')).toBe('draft');
    expect(slot('generate the vendor comparison as an excel workbook')).toBe('draft');
  });

  it('keeps coding work as code even when it mentions a document', () => {
    // The specific signal wins: this is TypeScript work that happens to name an approval note.
    expect(slot('implement the approval note writer in TypeScript')).toBe('code');
    expect(slot('fix the bug in the docx export')).toBe('code');
  });

  it('needs a producing verb, not merely a format word', () => {
    expect(slot('where is the word document stored')).not.toBe('draft');
  });

  it('sees the report before it drafts from it', () => {
    // The PS headline demo. Vision must win: nothing can be drafted from a report the model
    // cannot read, so the modality requirement outranks the deliverable format.
    expect(slot('read the scanned inspection report and draft an approval note as a Word file')).toBe('vision');
  });
});

describe('the existing weight axis is preserved', () => {
  it('still routes chat to chat and keeps the lite tier', () => {
    const d = decideSlot('thanks!');
    expect(d.slot).toBe('chat');
    expect(d.tier).toBe('lite');
  });

  it('still routes a self-contained knowledge question to chat', () => {
    expect(slot('what is the difference between let and const?')).toBe('chat');
  });

  it('still routes unmistakable coding work to code on the heavy tier', () => {
    const d = decideSlot('refactor the tokenizer to stream');
    expect(d.slot).toBe('code');
    expect(d.tier).toBe('heavy');
  });

  it('sends an ambiguous prompt to the capable model, as before', () => {
    const d = decideSlot('the governor keeps refusing my edits');
    expect(d.tier).toBe('heavy');
    expect(d.slot).toBe('code');
  });

  it('never throws on an empty prompt', () => {
    expect(() => decideSlot('')).not.toThrow();
    expect(decideSlot('').slot).toBe('chat');
  });
});

describe('resolving a slot to a model', () => {
  const catalogue: ModelEntry[] = [
    { label: 'Coder', value: 'org/coder-32b', desc: '', tier: 'coding', recommendedFor: ['coding'] },
    { label: 'Seer', value: 'org/seer-11b-vision', desc: '', tier: 'vision', recommendedFor: ['vision'] },
    { label: 'Quick', value: 'org/quick-3b', desc: '', tier: 'lite', recommendedFor: ['lite'] },
  ];

  it('reads recommendedFor, the metadata that was already there and unused', () => {
    expect(routeToModel('read the scanned P&ID', { catalogue }).model).toBe('org/seer-11b-vision');
    expect(routeToModel('refactor the parser', { catalogue }).model).toBe('org/coder-32b');
    expect(routeToModel('thanks!', { catalogue }).model).toBe('org/quick-3b');
  });

  it('serves a drafting turn from the coding slot, not the vision one', () => {
    expect(catalogueSlotFor('draft')).toBe('coding');
    expect(routeToModel('draft an approval note as a docx', { catalogue }).model).toBe('org/coder-32b');
  });

  it('lets an operator pin a slot to their own hardware', () => {
    // On an air-gapped GPU box the shipped catalogue ids are not even reachable.
    const choice = routeToModel('read the scanned P&ID', {
      catalogue, configured: { vision: 'local/qwen2-vl-7b' },
    });
    expect(choice.model).toBe('local/qwen2-vl-7b');
    expect(choice.via).toBe('configured');
  });

  it('says so plainly when the catalogue recommends nothing for a slot', () => {
    const choice = routeToModel('read the scanned P&ID', { catalogue: [catalogue[0]] });
    expect(choice.model).toBeNull();
    expect(choice.via).toBe('none');
  });

  it('explains the decision in terms an evaluator can check against the prompt', () => {
    const prompt = 'read the scanned inspection report';
    const text = explainRoute(prompt, routeToModel(prompt, { catalogue }));
    expect(text).toContain('Slot:    vision');
    expect(text).toContain('scanned');
    expect(text).toContain('org/seer-11b-vision');
    expect(text).toContain('no network, no model call');
  });
});

describe('the shipped catalogue can actually serve every slot', () => {
  it('recommends at least one model for coding, vision and lite', () => {
    for (const prompt of ['refactor the parser', 'read the scanned P&ID', 'thanks!']) {
      expect(routeToModel(prompt).model).toBeTruthy();
    }
  });
});
