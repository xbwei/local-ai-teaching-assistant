import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadDemo,checkDemo} from './check-demo.mjs';
import {assertValid} from './support.mjs';
const read=p=>JSON.parse(readFileSync(new URL('../'+p,import.meta.url),'utf8'));
test('v3 successor preserves v2 and adds only instructor minimized Local eligibility',async()=>{
 const original=await loadDemo();checkDemo(original);
 const profile=read('demo/v3/demo-profile.json');const policy=read('demo/v3/provider-eligibility.policy.json');const seed=read('demo/v3/comparison-seed.json');
 for(const name of ['demo-profile','demo-comparison-seed']){
  const schema=read(`schemas/v3/${name}.schema.json`);original.ajv.addSchema(schema);assertValid(original.ajv,schema.$id,name==='demo-profile'?profile:seed,name);
 }
 const normalize=v=>JSON.parse(JSON.stringify(v).replaceAll('demo-profile.v3','demo-profile.v2').replaceAll('demo-policy.v3','demo-policy.v2').replaceAll('demo-provider-eligibility.v3','demo-provider-eligibility.v2').replaceAll('demo-comparison-seed.v3','demo-comparison-seed.v2'));
 assert.deepEqual(normalize(profile),original.profile);assert.deepEqual(normalize(seed),original.seed);
 const expected=structuredClone(original.provider);expected.allowRules[0].dataClasses.push('IDENTITY_MINIMIZED_USER_TEXT');assert.deepEqual(normalize(policy),expected);
});

test('v4 active Owner profile is bounded and v3 residency remains frozen', async()=>{
 const original=await loadDemo();
 const profile=read('demo/v4/demo-profile.json');
 for(const name of ['demo-profile','demo-comparison-seed']){
  const schema=read(`schemas/v4/${name}.schema.json`);original.ajv.addSchema(schema);
  assertValid(original.ajv,schema.$id,name==='demo-profile'?profile:read('demo/v4/comparison-seed.json'),name);
 }
 assert.equal(profile.limits.localIdleUnloadSeconds,600);
 assert.equal(read('demo/v3/demo-profile.json').limits.localIdleUnloadSeconds,60);
 const schema=read('schemas/v4/demo-profile.schema.json');
 const bad=structuredClone(profile);bad.limits.localIdleUnloadSeconds=601;
 assert.equal(original.ajv.validate(schema.$id,bad),false);
 assert.equal(profile.comparison.inputPolicy,'EQUIVALENT_BOUNDED_CONVERSATION');
 assert.equal(profile.limits.maxResidentPrimaryModels,1);
});
