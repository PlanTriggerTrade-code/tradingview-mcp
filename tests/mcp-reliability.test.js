import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveSavedScript } from '../src/core/pine.js';
import { uiEvaluate } from '../src/core/ui.js';

test('Pine name resolution prefers exact and refuses ambiguous matches', () => {
 const scripts=[{id:'a',name:'Surge Bot'},{id:'b',name:'Surge Bot Research'}];
 assert.equal(resolveSavedScript(scripts,'surge bot').id,'a');
 assert.throws(()=>resolveSavedScript(scripts,'Surge'),/Ambiguous/);
 assert.throws(()=>resolveSavedScript([...scripts,{id:'c',name:'Surge Bot'}],'Surge Bot'),/Ambiguous/);
 assert.equal(resolveSavedScript(scripts,'missing'),undefined);
});
test('UI evaluation returns completed callback results and propagates rejection', async () => {
 const run=expression=>vm.runInNewContext(expression,{setTimeout});
 assert.deepEqual(JSON.parse(JSON.stringify(await uiEvaluate({expression:'new Promise(r=>setTimeout(()=>r({saved:true}),10))'},run))),{success:true,result:{saved:true}});
 await assert.rejects(uiEvaluate({expression:'Promise.reject(new Error("Save failed"))'},run),/Save failed/);
 const source=readFileSync(new URL('../src/core/ui.js',import.meta.url),'utf8');
 assert.match(source,/uiEvaluate\(\{ expression \}, run = evaluateAsync\)/);
});
test('new-tab click selects the button rather than its inert container', () => {
 const source=readFileSync(new URL('../src/core/tab.js',import.meta.url),'utf8');
 const expr=source.match(/const clicked = await evalIn\(`([\s\S]*?)`\);/)[1];
 let clicks=0;
 const document={querySelector:selector=>selector.startsWith('button[')?{click:()=>clicks++}:{click:()=>{}}};
 assert.equal(vm.runInNewContext(expr,{document}),true);
 assert.equal(clicks,1);
});
import { CLICK_PINE_BUTTON } from '../src/core/pine.js';
test('opening Pine does not toggle an already visible editor closed', () => {
 let clicks=0;
 const button={click:()=>clicks++};
 const document={querySelector:()=>button,querySelectorAll:()=>[{offsetParent:{}}]};
 vm.runInNewContext(CLICK_PINE_BUTTON,{document});
 assert.equal(clicks,0);
 document.querySelectorAll=()=>[];
 vm.runInNewContext(CLICK_PINE_BUTTON,{document});
 assert.equal(clicks,1);
});
