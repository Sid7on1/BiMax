import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Markdown} from '../../src/renderer/src/markdown';
import OutputWorkspace from '../../src/renderer/src/components/OutputWorkspace';
import {PathLinkContext} from '../../src/renderer/src/path.links';
const a=window as any;
a.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async(t:string)=>{a.copied.push(t);}}});
const make=(id:string,title:string,format:string,content:string)=>({record:{id,ownerThreadId:'A',producerRunId:'run',title,format,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),versions:[{id:id+'-v1',sha256:'fixture',byteLength:content.length,createdAt:new Date().toISOString()}]},version:{id:id+'-v1',sha256:'fixture',byteLength:content.length,createdAt:new Date().toISOString()},content,state:'available'});
const docs=JSON.parse(localStorage.getItem('outputs')||'null')||[
 make('table','Quarterly results','table',JSON.stringify([{name:'Beta',sales:2},{name:'Alpha',sales:1}])),
 make('chart','Revenue chart','vega-lite',JSON.stringify({data:{values:[{name:'A',sales:2},{name:'B',sales:5}]},mark:'bar',encoding:{x:{field:'name',type:'nominal'},y:{field:'sales',type:'quantitative'}},params:[{name:'cutoff',value:0,bind:{input:'range',min:0,max:10,step:1}}],transform:[{filter:'datum.sales >= cutoff'}]})),
 make('document','Editable report','document','<h1>Report</h1><p>Original report.</p><img src="https://tracking.invalid/image"><script>window.compromised=true</script>'),
 make('form','Project choices','form',JSON.stringify({fields:[{name:'color',label:'Color',type:'select',options:['Blue','Green']}]})),
 make('app','App source','react','export default function App(){return <p>Hello</p>}')];
const changed=new Set<()=>void>();
a.bimax={clipboard:{writeText:async(t:string)=>{a.copied.push(t);return true;}},outputs:{list:async()=>docs.map((d:any)=>d.record),read:async(id:string,v?:string)=>{const d=docs.find((d:any)=>d.record.id===id);return v?{...d,...d.history?.[v],version:d.record.versions.find((x:any)=>x.id===v)}:d;},onChanged:(cb:any)=>{changed.add(cb);return()=>changed.delete(cb);},onPreview:()=>()=>{},save:async(owner:string,input:any)=>{if(owner!=='A')throw new Error('owner');let d=docs.find((d:any)=>d.record.id===input.outputId);if(d){if(d.version.id!==input.baseVersion)throw new Error('stale');d.history={...d.history,[d.version.id]:{content:d.content}};d.content=input.content;d.version={...d.version,id:d.record.id+'-v'+(d.record.versions.length+1)};d.record.versions.push(d.version);}else {d=make(input.key,input.title,input.format,input.content);docs.push(d);}localStorage.setItem('outputs',JSON.stringify(docs));changed.forEach(f=>f());return JSON.parse(JSON.stringify(d));},export:async(id:string,v:string)=>{a.exported={id,v};return true;},cancelPreview:async()=>true,stop:async()=>true}};
a.followups=[];window.addEventListener('bimax:compose-insert',(e:any)=>a.followups.push(e.detail));
a.kept=[];window.addEventListener('bimax:keep-output',(e:any)=>a.kept.push(e.detail));
let setText:(t:string)=>void,setStream:(v:boolean)=>void;
function Probe(){const[text,update]=useState('# Rich answer\n\nHello **world** α 👋\n\n| Name | Value |\n| --- | --- |\n| Alpha | 2 |\n\nMath: $x^2$\n\n![tracking](https://tracking.invalid/pixel)\n\n<script>window.compromised=true</script>\n\n`src/example.ts`\n\n```js\nconst exact = "α 👋";\n```\n\nNote[^1]\n\n[^1]: Evidence.');const[stream,s]=useState(false);setText=update;setStream=s;return <><div id="answer"><PathLinkContext.Provider value={{open:()=>{a.pathOpened=true;}} as any}><Markdown text={text} streaming={stream}/></PathLinkContext.Provider></div><div id="workspace"><OutputWorkspace threadId="A"/></div></>;}
a.probe={render:(text:string,stream=false)=>flushSync(()=>{setText(text);setStream(stream);}),docs};
createRoot(document.getElementById('root')!).render(<Probe/>);
