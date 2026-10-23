import React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  FileCode2, FileCog, FileImage, FileJson, FileLock2, FileSpreadsheet,
  FileTerminal, FileText, FileType2, Folder, FolderOpen, Package,
} from 'lucide-react';

/**
 * One glyph and one colour per file kind.
 *
 * A tree where every row carries the same grey document icon makes the icon column pure decoration
 * — it costs 14px on every row and tells the reader nothing they cannot already read in the name.
 * Colour is doing the work here, so it is assigned by KIND rather than per-extension: five
 * families the eye can learn, not thirty it cannot. Extensions map into those families.
 */

type Kind = 'code' | 'markup' | 'data' | 'shell' | 'image' | 'config' | 'sheet' | 'lock' | 'plain';

const EXT_KIND: Record<string, Kind> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', go: 'code', rs: 'code', java: 'code', c: 'code', h: 'code',
  cpp: 'code', cc: 'code', swift: 'code', rb: 'code', php: 'code', kt: 'code',
  md: 'markup', mdx: 'markup', txt: 'plain', rst: 'markup',
  html: 'markup', htm: 'markup', css: 'markup', scss: 'markup', svg: 'image',
  json: 'data', jsonl: 'data', ndjson: 'data', yaml: 'config', yml: 'config', toml: 'config',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  csv: 'sheet', tsv: 'sheet', xlsx: 'sheet', xls: 'sheet',
  pdf: 'plain', docx: 'plain', pptx: 'plain',
  lock: 'lock', pem: 'lock', key: 'lock', env: 'lock',
};

/** Dotfiles carry their meaning in the whole name, not an extension. */
const NAME_KIND: Record<string, Kind> = {
  '.gitignore': 'config', '.gitattributes': 'config', '.env': 'lock', '.env.example': 'lock',
  '.prettierrc': 'config', '.eslintrc': 'config', '.editorconfig': 'config',
  '.mcp.json': 'data', '.ds_store': 'plain',
  'dockerfile': 'config', 'makefile': 'config', 'package.json': 'data',
  'package-lock.json': 'lock', 'bun.lockb': 'lock', 'yarn.lock': 'lock',
};

/**
 * Colour comes from the app's OWN palette — ember, moss, amber, rust — not from a new set invented
 * for this panel. Five accents already carry meaning across the product, and a tree that
 * introduced sky/violet/rose would be the only surface speaking them. Where two kinds share a hue
 * the GLYPH separates them, which is the right division of labour: shape distinguishes, colour
 * groups.
 */
const STYLE: Record<Kind, { icon: LucideIcon; className: string }> = {
  code: { icon: FileCode2, className: 'text-ember' },
  markup: { icon: FileType2, className: 'text-moss' },
  data: { icon: FileJson, className: 'text-amber' },
  config: { icon: FileCog, className: 'text-dim' },
  shell: { icon: FileTerminal, className: 'text-moss' },
  image: { icon: FileImage, className: 'text-amber' },
  sheet: { icon: FileSpreadsheet, className: 'text-moss' },
  lock: { icon: FileLock2, className: 'text-rust' },
  plain: { icon: FileText, className: 'text-faint' },
};

export function kindOf(name: string): Kind {
  const lower = name.toLowerCase();
  if (NAME_KIND[lower]) return NAME_KIND[lower];
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return EXT_KIND[ext] ?? 'plain';
}

export function FileIcon({ name, size = 13 }: { name: string; size?: number }): React.ReactElement {
  const { icon: Icon, className } = STYLE[kindOf(name)];
  return <Icon size={size} className={`shrink-0 ${className}`} />;
}

export function DirIcon({ open, name, size = 13 }: { open: boolean; name: string; size?: number }): React.ReactElement {
  // node_modules and other vendored trees read as one opaque blob, not a folder to explore.
  if (name === 'node_modules' || name === 'vendor') {
    return <Package size={size} className="shrink-0 text-faint" />;
  }
  const Icon = open ? FolderOpen : Folder;
  return <Icon size={size} className="shrink-0 text-ember/75" />;
}
