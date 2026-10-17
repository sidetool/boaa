/** Pure computation entry. No host RPC, settings, DOM, network or controller closure is injected. */
export const taskBootstrap = `(function() {
  const parse=JSON.parse, stringify=JSON.stringify;
  let plugin, ran=false;
  Object.defineProperty(globalThis,'BoaaPlugin',{value:Object.freeze({register(value) {
    if(plugin || !value || value.apiVersion!==2 || typeof value.run!=='function')throw Error('INVALID_REGISTRATION');
    plugin=value;
  }}),writable:false,configurable:false});
  Object.defineProperty(globalThis, 'MoyaPlugin', Object.getOwnPropertyDescriptor(globalThis, 'BoaaPlugin'));
  return async (op,text)=>{
    if(op!=='task' || ran || !plugin)throw Error('INVALID_STATE');
    ran=true;
    try { return stringify({ok:true,value:(await plugin.run(parse(text))) ?? null}); }
    catch { return stringify({ok:false,code:'GUEST_FAILURE'}); }
  };
})`;
