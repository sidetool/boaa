/** Trusted shim evaluated ONLY inside QuickJS. No browser-global eval or generic host request API. */
export const bootstrap = `(function(rpc) {
  const parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze;
  const commands = new Map(), events = new Map(), handlers = new Map(), decorations = new Map();
  const ordered = new Set();
  const changed = () => request('reader.decorations.changed',{ordered:[...ordered]});
  let httpSequence = 0;
  let plugin, active = false, current, manifest;
  const request = async (method, input) => {
    if (!current || current.aborted) throw Error('CANCELLED');
    const result = parse(await rpc(stringify({method, input})));
    if (!result.ok) throw Error(result.code);
    return result.value;
  };
  const add = (map, id, fn) => {
    if (!active || typeof id !== 'string' || typeof fn !== 'function' || map.has(id) || map.size >= 32) throw Error('INVALID_REGISTRATION');
    map.set(id, fn); return freeze({dispose() { map.delete(id); }});
  };
  const immutable = value => {
    if(value && typeof value==='object') { for(const key of Object.keys(value))immutable(value[key]);freeze(value); } return value;
  };
  const ctx = freeze({
    http: freeze({async request(input, signal) {
      if(signal?.aborted)return {ok:false,code:'HTTP_CANCELLED',outcome:'not-sent'};
      const id=++httpSequence;let cancelling;
      const cancel=()=>{cancelling=request('http.cancel',{id}).catch(()=>null);};
      // Dispatch before attaching the listener: RPC messages preserve order.
      const result=request('http.request',{id,request:input});
      signal?.addEventListener('abort',cancel);
      try{return await result;}finally{signal?.removeEventListener('abort',cancel);await cancelling;}
    }}),
    reader: freeze({
      state: () => request('reader.state.get', {}),
      content: freeze({
        read: (cursor) => request('reader.content.read', cursor === undefined ? {} : {cursor}),
        search: (query, cursor) => request('reader.content.search', cursor === undefined ? {query} : {query,cursor}),
      }),
      annotations: freeze({
        list: (kind, cursor) => request('reader.annotations.list', {kind,...(cursor === undefined ? {} : {cursor})}),
        create: (kind, paragraphId, textHash, fields, requestId) => request('reader.annotations.create', {kind,paragraphId,textHash,fields,requestId}),
        update: (handle, fields) => request('reader.annotations.update', {handle,fields}),
        delete: handle => request('reader.annotations.delete', {handle}),
      }),
      auto: freeze({
        start: (interactionId,speed) => request('reader.auto.start', {interactionId,speed}),
        update: (leaseId,speed) => request('reader.auto.update', {leaseId,speed}),
        stop: leaseId => request('reader.auto.stop', {leaseId}),
      }),
    }),
    decorations: freeze({
      async register(id, fn, options = {}) {
        if(!manifest.decorations?.includes(id) || !manifest.permissions.includes('reader.content.visible') || !manifest.permissions.includes('reader.decorations') || decorations.size>=8)throw Error('PERMISSION_DENIED');
        if(Object.keys(options).some(key=>key!=='mode') || (options.mode!==undefined && !['block','ordered-chapter'].includes(options.mode)))throw Error('INVALID_ARGUMENT');
        if(options.mode==='ordered-chapter' && !manifest.permissions.includes('reader.content.book'))throw Error('PERMISSION_DENIED');
        const handle=add(decorations,id,fn);
        if(options.mode==='ordered-chapter')ordered.add(id);
        try {await changed();}catch(error){handle.dispose();ordered.delete(id);throw error;}
        let disposed=false;
        return freeze({async dispose(){if(disposed)return;disposed=true;handle.dispose();ordered.delete(id);await changed();}});
      },
      invalidate: changed,
    }),
    handlers: freeze({register(id, fn) {
      if(typeof id!=='string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(id))throw Error('INVALID_HANDLER');
      return add(handlers,id,fn);
    }}),
    settings: freeze({get: () => request('settings.get', {}), set: (expectedRevision, value) => request('settings.set', {expectedRevision, value})}),
    tasks: freeze({run: input => request('tasks.run', {input})}),
    jobs: freeze({sleep: ms => request('jobs.sleep', {ms})}),
    commands: freeze({register(id, fn) {
      if (!manifest.commands.includes(id) || !manifest.permissions.includes('commands.register')) throw Error('PERMISSION_DENIED');
      return add(commands, id, fn);
    }}),
    events: freeze({on(id, fn) {
      if (!['app.ready','reader.entered','reader.exited','reader.contextChanged','settings.changed','view.opened','view.closed'].includes(id)) throw Error('UNKNOWN_EVENT');
      if (id === 'settings.changed' && !manifest.permissions.includes('settings.own')) throw Error('PERMISSION_DENIED');
      return add(events, id, fn);
    }}),
  });
  Object.defineProperty(globalThis, 'BoaaPlugin', {value: freeze({register(value) {
    if (plugin || !value || value.apiVersion !== 2 || typeof value.activate !== 'function') throw Error('INVALID_REGISTRATION');
    plugin = value;
  }}), writable: false, configurable: false});
  Object.defineProperty(globalThis, 'MoyaPlugin', Object.getOwnPropertyDescriptor(globalThis, 'BoaaPlugin'));
  return async (op, inputText) => {
    const input = parse(inputText);
    if (op === 'cancel') {
      if (current) { current.aborted = true; for (const fn of current.listeners) fn(); }
      return stringify(null);
    }
    if (!plugin || current) throw Error('INVALID_STATE');
    const job = {aborted: false, listeners: new Set()}; current = job;
    const signal = freeze({
      get aborted() { return job.aborted; },
      throwIfAborted() { if (job.aborted) throw Error('CANCELLED'); },
      addEventListener(name, fn) { if (name !== 'abort' || typeof fn !== 'function' || job.listeners.size >= 16) throw Error('INVALID_LISTENER'); job.listeners.add(fn); },
      removeEventListener(name, fn) { if (name === 'abort') job.listeners.delete(fn); },
    });
    try {
      let value = null;
      if (op === 'describe') { manifest = input; value = plugin.settings || null; }
      else if (op === 'activate') { if (active || !manifest) throw Error('INVALID_STATE'); active = true; await plugin.activate(ctx); }
      else if (op === 'decorate') {
        if(!active || !manifest.permissions.includes('reader.content.visible') || !manifest.permissions.includes('reader.decorations'))throw Error('PERMISSION_DENIED');
        immutable(input);const layers=[], checkpoints={};
        if(input.mode==='ordered-chapter' && !manifest.permissions.includes('reader.content.book'))throw Error('PERMISSION_DENIED');
        for(const [id,fn] of [...decorations]) {
          if(ordered.has(id)!==(input.mode==='ordered-chapter'))continue;
          const args=ordered.has(id)?immutable({...input,checkpoint:input.checkpoints?.[id]??null}):input;
          signal.throwIfAborted();const layer=await fn(args,signal);signal.throwIfAborted();
          if(ordered.has(id) && (layer===null || layer===undefined))throw Error('INVALID_CHECKPOINT');
          if(decorations.get(id)===fn && layer!==null && layer!==undefined) {
            if(!layer || typeof layer!=='object' || Array.isArray(layer) || Object.keys(layer).some(key=>!['ranges','palette',...(ordered.has(id)?['checkpoint']:[])].includes(key)))throw Error('INVALID_DECORATION');
            layers.push({id,ranges:layer.ranges,palette:layer.palette});
            if(ordered.has(id)) { if(!Object.hasOwn(layer,'checkpoint'))throw Error('INVALID_CHECKPOINT');checkpoints[id]=layer.checkpoint; }
          }
        }
        value=input.mode==='ordered-chapter'?{layers,checkpoints}:{layers};
      }
      else if (op === 'handler') {
        if (!active) throw Error('NOT_ACTIVE');
        const fn=handlers.get(input.id);
        if(!fn)value={ok:false,code:'UNKNOWN_HANDLER'};
        else {
          try { value={ok:true,value:(await fn(input.value,signal)) ?? null}; }
          catch { value={ok:false,code:'HANDLER_FAILED'}; }
        }
      }
      else if (op === 'command' || op === 'event') {
        if (!active) throw Error('NOT_ACTIVE');
        const fn = (op === 'command' ? commands : events).get(input.id);
        if (fn) value = (await fn(input.value, signal)) ?? null;
        else if (op === 'command') throw Error('UNKNOWN_COMMAND');
      } else throw Error('UNKNOWN_OPERATION');
      return stringify(job.aborted ? {ok:false,code:'CANCELLED'} : {ok:true,value});
    } catch { return stringify({ok:false,code:job.aborted ? 'CANCELLED' : 'GUEST_FAILURE'}); }
    finally { current = undefined; job.listeners.clear(); }
  };
})`;
