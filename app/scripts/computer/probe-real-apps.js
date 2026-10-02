#!/usr/bin/env electron
/**
 * Record 65 stage 6 (§6h), live on the owner's real apps, outside the installed app: the use service and Cua Driver 0.31
 * embedded in this process, scripted steps chosen by fixed rules (no model), the person played. It answers whether the
 * general abilities work on apps Bimax never saw — and whether anything switches windows: the front app and the pointer
 * are read (by Electron, not the driver) before and after every step.
 *
 * Privacy: nothing of a window's text is kept. The evidence holds roles, counts, outcome codes and card questions with
 * every chat or contact name replaced. Nothing is sent: the Send card is answered "Don’t press", and the text typed
 * into the message box is cleared again afterwards.
 *
 *   npx electron scripts/computer/probe-real-apps.js --apps music,whatsapp --out <evidence.json>
 *
 * Music:    look → type a song's name into the search box with Return (a search box: no card) → what came up.
 * WhatsApp: look → scroll the chat list (no card) until the row of the person's own chat ("(You)") shows, at most 12
 *           pages → open it → type one line into the message box (no card, read back) → press "Send": the card must
 *           appear, naming the typed text; answered Don’t press → clear the box (Bimax's own text: no card).
 */
const { app, screen } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const outPath = path.resolve(arg('out', path.join(os.tmpdir(), 'probe-real-apps.json')));
const apps = String(arg('apps', 'music,whatsapp')).split(',');

async function loadModules() {
  const esbuild = require(path.join(appRoot, 'node_modules', 'esbuild'));
  const outfile = path.join(os.tmpdir(), `bimax-probe-modules-${process.pid}.cjs`);
  await esbuild.build({
    stdin: { contents: "export * from './look.service'; export * from './look.driver'; export * from './look.manifest'; export * from './look.commit';", resolveDir: path.join(appRoot, 'src', 'main', 'computer'), loader: 'ts', sourcefile: 'probe-entry.ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error',
  });
  return require(outfile);
}

function frontApp() {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    return /"([^"]+)"/.exec(execFileSync('lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8' }))?.[1] ?? asn;
  } catch { return null; }
}
const where = () => ({ front: frontApp(), pointer: screen.getCursorScreenPoint() });

const evidence = { kind: 'live-real-apps-scripted', startedAt: new Date().toISOString(), apps, steps: [], cards: [], notes: [] };
const secrets = new Set();
const redact = (text) => { let t = String(text ?? ''); for (const s of secrets) if (s) t = t.split(s).join('<name>'); return t; };

app.whenReady().then(async () => {
  const cu = await loadModules();
  const real = cu.createLookDriver({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bimax-probe-state-')), packaged: false, resourcesPath: '', appPath: appRoot });
  // The script needs the controls a read showed to pick its next step; it keeps them in memory only.
  let last = [];
  const driver = {
    ...real,
    runningApps: () => real.runningApps(),
    look: async (...a) => { const r = await real.look(...a); last = r.elements ?? []; return r; },
    press: async (...a) => { const r = await real.press(...a); if (r.elements) last = r.elements; return r; },
    type: async (...a) => { const r = await real.type(...a); if (r.elements) last = r.elements; return r; },
    scroll: async (...a) => { const r = await real.scroll(...a); if (r.elements) last = r.elements; return r; },
    confirm: async (...a) => { const r = await real.confirm(...a); if (r.elements) last = r.elements; return r; },
    pick: async (...a) => { const r = await real.pick(...a); if (r.elements) last = r.elements; return r; },
    end: (...a) => real.end(...a),
  };
  const answers = [];
  const service = cu.createLookService({
    enabled: () => true, useEnabled: () => true, driver: async () => driver,
    ask: async (_t, question, options, body) => {
      const answer = answers.length ? answers.shift() : options[0];
      evidence.cards.push({ question: redact(question), options: options.map(redact), answer: redact(answer), bodyHasTypedText: null, body: redact(body) });
      return answer;
    },
    audit: (entry) => { (evidence.audit ??= []).push(entry); },
  });
  const threadId = 'probe-real-apps';
  let id = 0;
  const roles = (els) => els.reduce((m, e) => { m[e.role] = (m[e.role] ?? 0) + 1; return m; }, {});
  const step = async (name, capability, op, args, answer) => {
    if (answer !== undefined) answers.push(answer);
    const before = where();
    const cardsBefore = evidence.cards.length;
    const t0 = Date.now();
    const r = await service.handle(threadId, { t: 'host_call', id: ++id, capability, op, args });
    const after = where();
    const rec = {
      step: name, ok: r.ok, code: r.value?.code ?? null, ms: Date.now() - t0,
      // A refusal can quote a control's name — in a messaging app, a chat's name and last message — so WhatsApp steps keep
      // only the code (measured: a quoted long name slipped past the redaction once; that file was deleted, never kept).
      error: r.ok || /whatsapp/i.test(name) ? null : redact(r.error).slice(0, 300),
      resultLines: String(r.value?.text ?? '').split('\n').length,
      cards: evidence.cards.slice(cardsBefore).map((c) => c.question),
      frontBefore: before.front, frontAfter: after.front, pointerMoved: before.pointer.x !== after.pointer.x || before.pointer.y !== after.pointer.y,
    };
    evidence.steps.push(rec);
    console.log(`${name}: ${r.ok ? 'ok' : `refused ${rec.code}`} in ${rec.ms} ms, cards ${rec.cards.length}, front ${before.front} → ${after.front}${rec.pointerMoved ? ', POINTER MOVED' : ''}`);
    return { r, rec };
  };

  try {
    evidence.start = where();
    if (apps.includes('music')) {
      const { r } = await step('music: look', 'look', 'look', { app: 'Music' });
      evidence.musicWindow = { ok: r.ok, roles: roles(last), pressable: last.filter((e) => e.pressable).length, named: last.length };
      // Measured first: Play is greyed out (not pressable) until a song is queued, so playing starts with a search.
      evidence.musicWindow.playPressable = last.some((e) => e.pressable && /^play$/i.test(e.label));
      const search = last.filter((e) => e.editable && e.searchBox);
      evidence.musicWindow.searchBoxes = search.length;
      if (search.length === 1) {
        const before = new Set(last.map((e) => `${e.role}|${e.label}`));
        const q = await step('music: search with Return', 'type', 'type', { app: 'Music', field: search[0].label, role: search[0].role, text: 'Blinding Lights', submit: true });
        await new Promise((r) => setTimeout(r, 2500));
        await step('music: look at the results', 'look', 'look', { app: 'Music' });
        const fresh = last.filter((e) => !before.has(`${e.role}|${e.label}`));
        // A public catalogue, not the person's data: the first new controls are kept to show what a search brings up.
        evidence.musicWindow.afterSearch = { ok: q.r.ok, code: q.rec.code, newControls: fresh.length, sample: fresh.slice(0, 15).map((e) => `${e.role} ${e.label}`.slice(0, 80)) };
      } else evidence.notes.push(`music: ${search.length} search boxes in the window read`);
    }
    if (apps.includes('whatsapp')) {
      const { r } = await step('whatsapp: look', 'look', 'look', { app: 'WhatsApp' });
      evidence.whatsappWindow = { ok: r.ok, roles: roles(last), pressable: last.filter((e) => e.pressable).length, editable: last.filter((e) => e.editable).length, named: last.length };
      const isSelf = (e) => e.pressable && /\((you|yo|vous|du)\)|message yourself/i.test(e.label);
      let self = last.find(isSelf);
      // Scroll the chat list down, a page at a time, at a chat row, until the person's own chat shows.
      let scrolled = 0;
      while (!self && scrolled < 12) {
        const rows = last.filter((e) => e.role === 'AXButton' && e.pressable && e.label.length < 80);
        const anchor = rows[Math.floor(rows.length / 2)];
        if (!anchor) break;
        secrets.add(anchor.label);
        const sc = await step(`whatsapp: scroll the chat list (${scrolled + 1})`, 'scroll', 'scroll', { app: 'WhatsApp', control: anchor.label, role: anchor.role, direction: 'down', pages: 1 });
        scrolled += 1;
        if (!sc.r.ok) break;
        self = last.find(isSelf);
      }
      evidence.whatsappWindow.scrolledPages = scrolled;
      // Not among the recent chats: New Chat lists the person's own chat near the top.
      if (!self) {
        const plain = (t) => String(t).replace(/\p{Cf}/gu, '').trim();
        const look2 = await step('whatsapp: look again', 'look', 'look', { app: 'WhatsApp' });
        const newChat = look2.r.ok ? last.find((e) => e.pressable && /^new chat$/i.test(plain(e.label))) : undefined;
        if (newChat) {
          const nc = await step('whatsapp: open New Chat', 'press', 'press', { app: 'WhatsApp', control: newChat.label, role: newChat.role });
          self = nc.r.ok ? last.find(isSelf) : undefined;
          evidence.whatsappWindow.newChat = { ok: nc.r.ok, roles: roles(last), selfFound: !!self, editable: last.filter((e) => e.editable).length };
        }
      }
      evidence.whatsappWindow.selfChatRow = self ? self.role : null;
      if (!self) evidence.notes.push('whatsapp: no row for the person\'s own chat in the window read; nothing pressed');
      else {
        secrets.add(self.label); secrets.add(self.label.replace(/\s*\(.*$/, ''));
        const open = await step('whatsapp: open own chat', 'press', 'press', { app: 'WhatsApp', control: self.label, role: self.role });
        const boxes = last.filter((e) => e.editable && !cu.isSearchBox(e.role, e.label));
        evidence.whatsappWindow.messageBoxes = boxes.map((b) => ({ role: b.role, label: /message|compose|type|escrib|écri|nachricht/i.test(b.label) ? b.label : '<box>', empty: !(b.value ?? '').trim() }));
        if (open.r.ok && boxes.length === 1) {
          const text = `Bimax test, not sent ${Date.now() % 1000}`;
          const box = boxes[0];
          const typed = await step('whatsapp: type into the message box', 'type', 'type', { app: 'WhatsApp', field: box.label, role: box.role, text });
          evidence.whatsappWindow.typedReadBack = typed.r.ok;
          const send = last.find((e) => e.pressable && /^send$/i.test(e.label));
          evidence.whatsappWindow.sendButton = send ? send.role : null;
          if (typed.r.ok && send) {
            await step('whatsapp: press Send (card answered Don’t press)', 'press', 'press', { app: 'WhatsApp', control: send.label, role: send.role }, 'Don’t press');
            const card = evidence.cards[evidence.cards.length - 1];
            evidence.whatsappWindow.sendCard = { question: card?.question, showsText: !!card?.body.includes(text), showsOpened: !!card?.body.includes('Bimax last opened here: “<name>'), answered: card?.answer };
          }
          // Clear Bimax's own text again; look first if the last step used up the read.
          const after = last.find((e) => e.editable && e.role === box.role && e.at === box.at);
          if (after) {
            const clear = await step('whatsapp: clear the box', 'type', 'type', { app: 'WhatsApp', field: after.label, role: after.role, text: '' });
            if (!clear.r.ok && clear.rec.code === 'stale') {
              await step('whatsapp: look again', 'look', 'look', { app: 'WhatsApp' });
              const again = last.find((e) => e.editable && e.role === box.role && e.at === box.at);
              if (again) await step('whatsapp: clear the box', 'type', 'type', { app: 'WhatsApp', field: again.label, role: again.role, text: '' });
            }
          }
        } else if (open.r.ok) evidence.notes.push(`whatsapp: ${boxes.length} message boxes after opening the chat; not typed`);
      }
    }
    evidence.driverActivity = driver.activity ? real.activity(threadId) : null;
    evidence.serviceCounts = service.counts(threadId);
    await real.end(threadId);
  } catch (error) {
    evidence.notes.push(`threw: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  evidence.end = where();
  evidence.finishedAt = new Date().toISOString();
  // Final privacy pass over everything kept.
  const json = redact(JSON.stringify(evidence, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
  console.log(`evidence: ${outPath}`);
  app.exit(0);
});
