import {ThinkingIndicator} from '../../src/renderer/src/components/ThinkingIndicator';
import {THINKING_VERBS} from '../../src/renderer/src/thinking.model';
import React, {useSyncExternalStore} from 'react';
import {Transcript} from '../../src/renderer/src/components/Transcript';
import {EngineStore} from '../../src/renderer/src/engine.store';
import {initialEngineState} from '../../src/renderer/src/engine.state';
import { createRoot } from 'react-dom/client';
import {ConversationMessage} from '../../src/renderer/src/components/ConversationMessage';
import { Markdown } from '../../src/renderer/src/markdown';
const root=createRoot(document.getElementById('root')!);
(window as any).renderMarkdown=(text:string,streaming=false)=>root.render(<Markdown text={text} streaming={streaming}/>);

(window as any).renderMessage=(message:any)=>root.render(<ConversationMessage {...message}/>);

(window as any).renderThinking=(props:any)=>root.render(<ThinkingIndicator {...props}/>);
(window as any).thinkingVerbs=THINKING_VERBS;

let canvasStore:EngineStore;
function Canvas(){const state=useSyncExternalStore(canvasStore.domains.transcript.subscribe,canvasStore.domains.transcript.getSnapshot);return <div style={{height:'90vh',display:'flex',flexDirection:'column'}} className="canvas-fixture"><Transcript store={canvasStore} items={state.items} onMenuSelect={()=>{}}/></div>;}
(window as any).renderDesktopCanvas=(text:string)=>{canvasStore=new EngineStore({...initialEngineState,streaming:text});root.render(<Canvas/>);};
(window as any).finishDesktopCanvas=()=>{canvasStore.dispatch({type:'outbound',msg:{t:'event',name:'message',args:[{id:'finished-canvas',role:'assistant',content:canvasStore.getState().streaming,timestamp:new Date()}]}});return canvasStore.getState();};
