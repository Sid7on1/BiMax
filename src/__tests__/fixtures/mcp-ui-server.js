const { Server }=require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport }=require('@modelcontextprotocol/sdk/server/stdio.js');
const {ListToolsRequestSchema,CallToolRequestSchema,ReadResourceRequestSchema,ListResourcesRequestSchema}=require('@modelcontextprotocol/sdk/types.js');
const server=new Server({name:'ui-fixture',version:'1'},{capabilities:{tools:{},resources:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'counter',description:'A tool UI fixture',inputSchema:{type:'object',properties:{value:{type:'number'}}},_meta:{ui:{resourceUri:'ui://counter',visibility:['model','app']}}}]}));
server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'ui://counter',name:'Counter',mimeType:'text/html;profile=mcp-app'}]}));
server.setRequestHandler(ReadResourceRequestSchema,async(req)=>({contents:[{uri:req.params.uri,mimeType:'text/html;profile=mcp-app',text:'<button>Counter fixture</button>'}]}));
server.setRequestHandler(CallToolRequestSchema,async(req)=>({content:[{type:'text',text:'Count '+req.params.arguments.value}],structuredContent:{value:req.params.arguments.value}}));
server.connect(new StdioServerTransport());
