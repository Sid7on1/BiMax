import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const sourcePath = "/Users/vishsiddharth/Library/Containers/net.whatsapp.WhatsApp/Data/tmp/documents/62571291-7C4A-456D-A4C8-FF5F44E096A6/SIH2026-IDEA-Presentation-Format.pptx";
const presentation = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
for (const query of [
  "slide delete remove presentation.slides",
  "shape delete remove",
  "text style paragraphs bullets autofit",
  "connector arrows",
]) {
  const result = presentation.help("*", { search: query, include: ["index", "examples", "notes"], maxChars: 10000 });
  console.log(`QUERY ${query}\n${result.ndjson}\n`);
}
