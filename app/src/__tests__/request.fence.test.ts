import { RequestFence } from '../renderer/src/request.fence';
test('a late response cannot replace a newer response for the same directory', async () => {
 const fence = new RequestFence(); const first=fence.begin('src'); const second=fence.begin('src');
 let files=['current'];
 await Promise.resolve().then(()=>{if(second()) files=['new'];});
 await Promise.resolve().then(()=>{if(first()) files=['old'];});
 expect(files).toEqual(['new']);
});
test('independent directories can load together', () => {
 const fence=new RequestFence(); const a=fence.begin('src'); const b=fence.begin('docs');
 expect(a()).toBe(true); expect(b()).toBe(true);
});
test('project change or unmount invalidates every reply, even when the next project uses the same paths', () => {
 const fence=new RequestFence(); const oldRoot=fence.begin(''); const oldChild=fence.begin('src');
 fence.invalidate(); const newRoot=fence.begin('');
 expect(oldRoot()).toBe(false); expect(oldChild()).toBe(false); expect(newRoot()).toBe(true);
 fence.invalidate(); expect(newRoot()).toBe(false);
});
