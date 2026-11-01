import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const data = JSON.parse(document.getElementById('tool-data')!.textContent!);
const frame = document.createElement('iframe');
frame.setAttribute('sandbox', 'allow-scripts');
frame.style.cssText = 'border:0;width:100%;height:100vh;display:block';
frame.title = 'Isolated tool interface';
const bridge = new AppBridge(null, { name: 'Bimax', version: '1.1.0' }, { serverTools: {}, logging: {} });
bridge.oncalltool = async ({ name, arguments: args }) => (window as any).outputHost.call(name, args || {});
bridge.oninitialized = () => {
  void bridge
    .sendToolInput({ arguments: data.input || {} })
    .then(() => bridge.sendToolResult(data.result || { content: [] }));
};
// Keep UI-authored chat/context changes out of the authoritative conversation. The user can select text and ask from chat.
bridge.onmessage = async () => {
  throw new Error('Compose a message in chat to send it.');
};
bridge.onupdatemodelcontext = async () => {
  throw new Error('Automatic context injection is not supported.');
};
bridge.onopenlink = async () => {
  throw new Error('External navigation is disabled in this offline preview.');
};
frame.addEventListener(
  'load',
  () => {
    void bridge
      .connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!))
      .catch(console.error);
  },
  { once: true },
);
frame.srcdoc = data.html;
document.body.style.margin = '0';
document.body.appendChild(frame);
