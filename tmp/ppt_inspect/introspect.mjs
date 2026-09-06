import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const sourcePath = "/Users/vishsiddharth/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/62571291-7C4A-456D-A4C8-FF5F44E096A6/SIH2026-IDEA-Presentation-Format.pptx";
const p = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
const s = p.slides.getItem(0);
const shape = s.shapes.items.find(x => x.text);
function props(x){ const out=new Set(); let o=x; while(o&&o!==Object.prototype){ for(const k of Object.getOwnPropertyNames(o)) out.add(k); o=Object.getPrototypeOf(o);} return [...out].sort(); }
console.log('slides', props(p.slides));
console.log('slide', props(s));
console.log('shapes', props(s.shapes));
console.log('shape', props(shape));
console.log('text', props(shape.text));
console.log('textstyle', props(shape.text.style));
console.log('paras', props(shape.text.paragraphs));
