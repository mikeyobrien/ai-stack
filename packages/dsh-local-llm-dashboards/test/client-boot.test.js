import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
function plugin(){let result;vm.runInNewContext(fs.readFileSync(new URL('../client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(row){result=row.factory(()=>({createElement(){},useState(){throw new Error('React hooks cannot run during Cordis plugin apply')},useEffect(){}}));}}},console});return result;}
test('browser boot activates before its remote face exists and mounts the overview contract',async()=>{
 const p=plugin();assert.ok(!p.inject.includes('remote.sparks'),'remote.sparks must not block the plugin that mounts it');
 let mounted;const disposers=[];const ctx={locale:{register(ns,dicts){assert.equal(ns,'sparks');assert.equal(dicts.en.panel,'Local Models');return()=>{}},getSnapshot(){return{}},bind(){return k=>k}},remote:{$mount(c){mounted=c;return Promise.resolve()}},slots:{inject(){return()=>{}},register(){return()=>{}}},effect(fn){const d=fn();if(d)disposers.push(d)},inject(keys,fn){assert.deepEqual(Array.from(keys),['remote.sparks']);return{dispose(){}}}};
 p.apply(ctx);await Promise.resolve();assert.equal(mounted.package,'@local/dsh-local-llm-dashboards');assert.equal(mounted.descriptors[0].namespace,'sparks');assert.equal(mounted.descriptors[0].method,'overview');for(const d of disposers)d();
});
