import fs from 'node:fs';
import path from 'node:path';
test('the built flight gate rejects a merely no-slower exit, and allows one frame of quantisation around 75%',()=>{
 const checker=fs.readFileSync(path.resolve(__dirname,'../../scripts/ui/morph-regression.mjs'),'utf8');
 const condition=checker.match(/if \((out && into && out\.settleMs [^\n]*?)\) results\.find/);
 expect(condition).not.toBeNull();
 // Execute the production predicate, with observations chosen independently of the current golden.
 const violates=new Function('out','into','FRAME_MS',`return ${condition![1]}`) as (out:{settleMs:number},into:{settleMs:number},frame:number)=>boolean;
 const check=(out:number,into:number)=>violates({settleMs:out},{settleMs:into},1000/60);
 expect(check(184,217)).toBe(true);expect(check(283,283)).toBe(true);
 expect(check(167,217)).toBe(false);expect(check(200,267)).toBe(false);expect(check(217,300)).toBe(false);
});
