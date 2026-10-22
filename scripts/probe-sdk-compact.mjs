import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
delete process.env.BUN_OPTIONS;
const events = [], requests = [];
const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
  if(request.method==='HEAD') return new Response(null);
  const body=await request.json();
  if(new URL(request.url).pathname.includes('count_tokens')) return Response.json({input_tokens:100});
  if(new URL(request.url).pathname!=='/v1/messages') return Response.json({});
  requests.push(body);
  const id=`msg_probe_${requests.length}`, text='The user asked to remember COMPACT_MEMORY_1769. Keep that code.';
  const usage={input_tokens:100,output_tokens:20};
  if(!body.stream) return Response.json({id,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',usage});
  const frames=[['message_start',{type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{...usage,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:20}}],['message_stop',{type:'message_stop'}]];
  return new Response(frames.map(([event,value])=>`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}});
const sdk=await import(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',import.meta.url).href);
let push;
async function* inputs(){while(true)yield await new Promise(r=>push=r);}
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),60000);
const connection=sdk.query({prompt:inputs(),options:{pathToClaudeCodeExecutable:(await import('../src/sdk.ts')).sdkExecutable(),settingSources:[],strictMcpConfig:true,mcpServers:{},tools:[],settings:{disableAllHooks:true},includePartialMessages:true,model:'claude-opus-5',systemPrompt:'Answer briefly.',abortController:controller,env:{...process.env,BUN_OPTIONS:undefined,ANTHROPIC_BASE_URL:server.url.origin,ANTHROPIC_API_KEY:'sk-local-fixture',ANTHROPIC_AUTH_TOKEN:undefined,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:'',NO_PROXY:'*',no_proxy:'*'}}});
const commands=['Remember COMPACT_MEMORY_1769','Second turn','Third turn','/compact Keep the remembered code'];
let turn=0;
const pump=(async()=>{for await(const message of connection){events.push({...message,probeTurn:turn});if(message.type==='result'){turn++;if(turn===commands.length) break; while(!push) await Bun.sleep(10); const p=push;push=undefined;p({type:'user',uuid:randomUUID(),parent_tool_use_id:null,message:{role:'user',content:commands[turn]}});}}})();
try{
 await connection.initializationResult();
 while(!push)await Bun.sleep(10);
 const p=push;push=undefined;p({type:'user',uuid:randomUUID(),parent_tool_use_id:null,message:{role:'user',content:commands[0]}});
 await pump;
 mkdirSync(new URL('../test/artifacts',import.meta.url),{recursive:true});
 writeFileSync(new URL('../test/artifacts/sdk-compact-probe.json',import.meta.url),JSON.stringify({events,requests},null,2));
 console.log(JSON.stringify(events.filter(e=>e.probeTurn===3 && e.type!=='stream_event'),null,2));
}finally{clearTimeout(timer);connection.close();server.stop(true);}
process.exit(0);
