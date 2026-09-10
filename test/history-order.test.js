const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const frontend = path.resolve(__dirname, '../../js/features');
const available = fs.existsSync(path.join(frontend, '70-gpt-sessions.js'));
const load = extra => {
    const context = vm.createContext({ console: { warn(){}, error(){} },
        document: { getElementById: () => ({ classList: { contains: () => false } }) },
        persistSessionsToBrowser(){}, renderHistoryList(){}, ...extra });
    vm.runInContext(fs.readFileSync(path.join(frontend, '70-gpt-sessions.js'), 'utf8'), context);
    return context;
};

test('recent chat ordering ignores later sync timestamps and preserves pin priority', { skip: !available }, () => {
    const c = load();
    vm.runInContext(`chatSessions = [
        {id:'old',title:'old',createdAt:10,updatedAt:99999,messages:[{id:'a',createdAt:100}]},
        {id:'pelican',title:'pelican',createdAt:20,updatedAt:500,messages:[{id:'b',createdAt:200}]}
    ];`, c);
    assert.equal(vm.runInContext('getOrderedSessions()[0].id', c), 'pelican');
    vm.runInContext('chatSessions[0].pinned=true', c);
    assert.equal(vm.runInContext('getOrderedSessions()[0].id', c), 'old');
});

test('failed first cloud load retries, malformed local cache does not block recovery', { skip: !available }, async () => {
    let calls = 0;
    const c = load({
        localStorage: { getItem:key => key.includes('client_id') ? 'valid-client-identity' : '{broken', setItem(){} },
        tuoApiFetch: async () => { calls++; return calls === 1 ? {ok:false,status:503} : {ok:true,json:async()=>({sessions:[{id:'restored',createdAt:10,updatedAt:20,messages:[{id:'m',role:'user',content:'preserved',createdAt:20}]}]})}; }
    });
    await vm.runInContext('ensureGPTSessionsLoaded()', c);
    assert.equal(calls, 1);
    await vm.runInContext('ensureGPTSessionsLoaded()', c);
    assert.equal(calls, 2);
    assert.equal(vm.runInContext('chatSessions[0].messages[0].content', c), 'preserved');
});

test('full browser cache cannot stop cloud synchronization', { skip: !available }, () => {
    const s = fs.readFileSync(path.join(frontend, '74-gpt-chat.js'),'utf8');
    const body = s.slice(s.indexOf('function saveSessions()'),s.indexOf("window.addEventListener('pagehide'"));
    let syncs = 0;
    vm.runInNewContext(body + ';saveSessions();', {
        gptSessionsLoaded:true,saveSessionsTimer:null,clearTimeout(){},setTimeout(fn){fn();},
        persistSessionsToBrowser(){throw Error('QuotaExceededError');},syncChangedGPTSessions(){syncs++;},
        showGPTTransientStatus(){}, console:{error(){}}
    });
    assert.equal(syncs,1);
});

test('browser never overlaps history sync calls and can sync later changes', { skip: !available }, async () => {
    let finish, calls = 0;
    const c = load({
        GPTProgress: { normalize: () => null },
        localStorage: { getItem: () => 'valid-client-identity' },
        tuoApiFetch: () => { calls++; return new Promise(resolve => { finish = resolve; }); }
    });
    vm.runInContext("chatSessions = [{id:'s', updatedAt:1, messages:[]}];", c);
    const first = vm.runInContext('syncChangedGPTSessions()', c);
    await vm.runInContext('syncChangedGPTSessions()', c);
    assert.equal(calls, 1); finish({ ok: true }); await first;
    await vm.runInContext('syncChangedGPTSessions()', c); assert.equal(calls, 1);
    vm.runInContext('chatSessions[0].updatedAt=2', c);
    const next = vm.runInContext('syncChangedGPTSessions()', c);
    assert.equal(calls, 2); finish({ ok: true }); await next;
});
