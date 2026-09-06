import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const sourcePath = "/Users/vishsiddharth/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/62571291-7C4A-456D-A4C8-FF5F44E096A6/SIH2026-IDEA-Presentation-Format.pptx";
const presentation = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
const snapshot = await presentation.inspect({
  kind: "deck,slide,textbox,shape,image,table,chart,notes,layout",
  include: "id,slide,name,title,text,textPreview,textChars,textLines,bbox,bboxUnit,isPlaceholder,placeholders,alt",
  maxChars: 30000,
});
console.log(snapshot.ndjson);
console.log(JSON.stringify({
  slideCount: presentation.slides.items.length,
  slideSize: presentation.slideSize,
  masters: presentation.masters.items.map((m) => ({ id: m.id, name: m.name })),
  layouts: presentation.layouts.items.map((l) => ({ id: l.id, name: l.name, placeholders: l.placeholders.summary() })),
}, null, 2));
