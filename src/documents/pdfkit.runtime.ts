import type PDFKitModule from 'pdfkit';

/**
 * pdfkit, loaded so that its standard fonts exist inside the compiled engine.
 *
 * pdfkit's Node build registers the 14 PDF standard fonts as lazy loaders —
 * `() => require$1('#standard-fonts/Helvetica')`, with `require$1 = createRequire(...)`. A bundler
 * cannot follow that alias, so `bun build --compile` never packs the font data, and the first
 * `doc.font()` in the engine binary throws `Cannot find module '#standard-fonts/Helvetica'`. Every
 * PDF the DocumentTool was asked for failed that way — the model then pip-installed Python PDF
 * libraries to work around it — while jest, running plain Node, stayed green. pdfkit 0.20.2 is the
 * latest release, and its Node entry does not export `registerStdFonts`.
 *
 * So the font data is required below with literal specifiers, which the bundler does pack, and
 * pdfkit is loaded while `createRequire` answers `#standard-fonts/*` from that table. It has to be
 * the CommonJS build: that one reads `module.createRequire` as a property when it loads, whereas
 * the ESM build binds the import before any of this can run. The patch is undone the moment
 * pdfkit has loaded.
 *
 * Measured with a compiled probe (2026-09-13): the ESM build, bundling the font modules alone, and
 * a Bun runtime plugin all still threw; this path produced a valid `%PDF-`.
 */
const STANDARD_FONTS: Record<string, unknown> = {
  Courier: require('pdfkit/standard-fonts/Courier'),
  CourierBold: require('pdfkit/standard-fonts/CourierBold'),
  CourierBoldOblique: require('pdfkit/standard-fonts/CourierBoldOblique'),
  CourierOblique: require('pdfkit/standard-fonts/CourierOblique'),
  Helvetica: require('pdfkit/standard-fonts/Helvetica'),
  HelveticaBold: require('pdfkit/standard-fonts/HelveticaBold'),
  HelveticaBoldOblique: require('pdfkit/standard-fonts/HelveticaBoldOblique'),
  HelveticaOblique: require('pdfkit/standard-fonts/HelveticaOblique'),
  Symbol: require('pdfkit/standard-fonts/Symbol'),
  TimesBold: require('pdfkit/standard-fonts/TimesBold'),
  TimesBoldItalic: require('pdfkit/standard-fonts/TimesBoldItalic'),
  TimesItalic: require('pdfkit/standard-fonts/TimesItalic'),
  TimesRoman: require('pdfkit/standard-fonts/TimesRoman'),
  ZapfDingbats: require('pdfkit/standard-fonts/ZapfDingbats'),
};

const FONT_PREFIX = '#standard-fonts/';

function loadPdfkit(): typeof PDFKitModule {
  const nodeModule: { createRequire: (from: string | URL) => NodeRequire } = require('module');
  const createRequire = nodeModule.createRequire;
  nodeModule.createRequire = (from) => {
    const real = createRequire(from);
    const withFonts = (id: string): unknown => {
      const name = id.startsWith(FONT_PREFIX) ? id.slice(FONT_PREFIX.length) : '';
      return name in STANDARD_FONTS ? STANDARD_FONTS[name] : real(id);
    };
    return Object.assign(withFonts, real);
  };
  try {
    const loaded = require('pdfkit');
    return loaded.default ?? loaded;
  } finally {
    nodeModule.createRequire = createRequire;
  }
}

export const PDFDocument = loadPdfkit();
