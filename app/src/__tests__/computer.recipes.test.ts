import { ComputerRecipes } from '../main/computer/recipes';
import { mkdtemp, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('Saved verified instructions survive a new store without process authority or executable data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cu-recipes-'));
  try {
    const store = new ComputerRecipes(root);
    await store.save('Save Message', '@CU Review these literal workflow steps before executing.');
    const files = await readdir(root); expect(files).toHaveLength(1);
    expect((await stat(path.join(root, files[0]))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(root, files[0]), 'utf8'))).toEqual({name:'Save Message',text:'@CU Review these literal workflow steps before executing.'});
    await writeFile(path.join(root,'1-12345678-1234-1234-1234-123456789abc.json'), '{broken');
    await writeFile(path.join(root,'2-12345678-1234-1234-1234-123456789abc.json'), JSON.stringify({name:'forged',text:'shell execute'}));
    expect(await new ComputerRecipes(root).list()).toEqual([{name:'Save Message',text:'@CU Review these literal workflow steps before executing.'}]);
    await expect(store.save('bad','not a CU message')).rejects.toThrow();
    await expect(store.save('bad','@CU '+ 'x'.repeat(32000))).rejects.toThrow();
  } finally { await rm(root,{recursive:true,force:true}); }
});
