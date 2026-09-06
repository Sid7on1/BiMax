import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const sourcePath = "/Users/vishsiddharth/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/62571291-7C4A-456D-A4C8-FF5F44E096A6/SIH2026-IDEA-Presentation-Format.pptx";
const p = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
for (let i=0;i<6;i++) {
  console.log('slide', i+1);
  for (const s of p.slides.getItem(i).shapes.items.filter(x => x.text)) {
    console.log(s.name, {frame:s.frame, style:s.text.style, fill:s.fill, line:s.line});
  }
}
