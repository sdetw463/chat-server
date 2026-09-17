const test = require('node:test');
const assert = require('node:assert/strict');
const { linkedSandboxPaths, resolveLinkedGeneratedFiles } = require('../lib/generated-files');
const message = text => ({type:'message',content:[{type:'output_text',text}]});
test('missing citations are recovered only from verified generated files in this response container', async () => {
 const r={output:[{type:'code_interpreter_call',status:'completed',container_id:'own'},message('[result](sandbox:/mnt/data/result.txt) [input](sandbox:/mnt/data/input.csv)')]};
 const client={containers:{files:{list:async function*(id){assert.equal(id,'own');yield {id:'generated',container_id:id,source:'assistant',path:'/mnt/data/result.txt'};yield {id:'input',container_id:id,source:'user',path:'/mnt/data/input.csv'};yield {id:'other',container_id:'other',source:'assistant',path:'/mnt/data/input.csv'};}}}};
 const result=await resolveLinkedGeneratedFiles(r,[],client);
 assert.deepEqual(result.citations,[{fileId:'generated',containerId:'own',filename:'result.txt'}]);
 assert.deepEqual(result.unresolved,['/mnt/data/input.csv']);
});
test('model links cannot select arbitrary containers, paths or previously uploaded files', async () => {
 const r={output:[message('[bad](sandbox:/mnt/data/../secret) [bad](sandbox:/mnt/data/%2E%2E/secret) [text](sandbox:/mnt/data/claimed.txt)')]};
 assert.deepEqual(linkedSandboxPaths(r),['/mnt/data/claimed.txt']);
 const result=await resolveLinkedGeneratedFiles(r,[],{});
 assert.deepEqual(result.citations,[]);assert.equal(result.unresolved.length,1);
});
test('an official citation avoids redundant container listing', async () => {
 const c=[{fileId:'known',containerId:'own',filename:'result.txt'}];
 const r=await resolveLinkedGeneratedFiles({output:[message('[file](sandbox:/mnt/data/result.txt)')]},c,{});
 assert.deepEqual(r,{citations:c,unresolved:[]});
});
test('recovery closes the file iterator as soon as every linked file is found', async () => {
 const response={output:[{type:'code_interpreter_call',status:'completed',container_id:'own'},message('[result](sandbox:/mnt/data/result.txt)')]};
 let closed=false;
 const client={containers:{files:{list:async function*(){try {
  yield {id:'generated',container_id:'own',source:'assistant',path:'/mnt/data/result.txt'};
  assert.fail('must not fetch another file or page after resolving the last link');
 } finally {closed=true;}}}}};
 const result=await resolveLinkedGeneratedFiles(response,[],client);
 assert.equal(result.citations.length,1);assert.deepEqual(result.unresolved,[]);assert.equal(closed,true);
});
test('stopping a chat cancels an in-flight generated-file lookup', async () => {
 const response={output:[{type:'code_interpreter_call',status:'completed',container_id:'own'},message('[result](sandbox:/mnt/data/result.txt)')]};
 const controller=new AbortController(), reason=new Error('stopped');
 let begin;
 const started=new Promise(resolve=>begin=resolve);
 const client={containers:{files:{list:async function*(id,query,options){
  assert.equal(options.signal,controller.signal);begin();
  await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }}}};
 const pending=resolveLinkedGeneratedFiles(response,[],client,{signal:controller.signal});
 await started;controller.abort(reason);
 await assert.rejects(pending,error=>error===reason);
 await assert.rejects(resolveLinkedGeneratedFiles(response,[],{}, {signal:controller.signal}),error=>error===reason);
});
