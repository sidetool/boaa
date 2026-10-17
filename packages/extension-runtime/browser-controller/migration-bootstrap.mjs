/** Registration only: activate is never called; no host APIs are injected. */
export const migrationBootstrap = `(function() {
  const parse=JSON.parse, stringify=JSON.stringify;
  let plugin, ran=false;
  Object.defineProperty(globalThis,'BoaaPlugin',{value:Object.freeze({register(value) {
    if(plugin || !value || value.apiVersion!==2 || typeof value.activate!=='function')throw Error('INVALID_REGISTRATION');
    plugin=value;
  }}),writable:false,configurable:false});
  Object.defineProperty(globalThis, 'MoyaPlugin', Object.getOwnPropertyDescriptor(globalThis, 'BoaaPlugin'));
  return async (op,text)=>{
    if(op!=='migrate' || ran || !plugin || !plugin.settings)throw Error('INVALID_STATE');
    ran=true;
    try {
      const input=parse(text);
      let value=input.value;
      if(typeof plugin.migrateSettings==='function') value=await plugin.migrateSettings(input);
      else if(plugin.settings.version!==input.fromVersion)throw Error('MIGRATION_REQUIRED');
      return stringify({ok:true,value:{schema:plugin.settings,value}});
    } catch { return stringify({ok:false,code:'GUEST_FAILURE'}); }
  };
})`;
