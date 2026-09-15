import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { AdminAuth, hashAdminPassword } from '../server/admin.mjs';
import { createApp } from '../server/app.mjs';
import { MemoryStore } from '../server/store.mjs';
const origin='https://commons.example.org', password='a long administrator test password';
const hash=await hashAdminPassword(password);
const calendars=()=>[{id:'one',name:'First calendar',organizerToken:'shared-organizer-secret',store:new MemoryStore(),radicale:{password:'backend-secret'}},{id:'two',name:'Second calendar',organizerToken:'shared-organizer-secret',store:new MemoryStore()},{id:'other',name:'Other calendar',organizerToken:'unrelated-secret',store:new MemoryStore()}];
const setup=(options={})=>{const auth=new AdminAuth({passwordHash:hash,production:true,...options});const app=createApp({calendars:calendars(),adminAuth:auth,production:true,publicOrigin:origin});return {app,auth};};
const login=app=>request(app).post('/admin/api/login').set('Origin',origin).send({password});
const cookie=r=>r.headers['set-cookie'][0].split(';')[0];

test('admin hash rejects bad configuration and verifies passwords without storing plaintext',async()=>{
  const {auth}=setup(); assert.match(hash,/^scrypt:131072:8:1:/);assert.ok(!hash.includes(password));
  assert.equal(await auth.verify(password),true);assert.equal(await auth.verify('wrong'),false);
  assert.equal(await auth.verify({password}),false);assert.equal(await auth.verify('x'.repeat(1025)),false);
  assert.throws(()=>new AdminAuth({passwordHash:'plaintext'}));await assert.rejects(hashAdminPassword('short'));
});
test('admin is disabled by default and organizer credentials cannot authorize any admin endpoint',async()=>{
  const app=createApp({calendars:calendars(),publicOrigin:origin});
  assert.deepEqual((await request(app).get('/admin/api/session')).body,{enabled:false,authenticated:false});
  await login(app).expect(503);
  for(const path of ['/calendars','/settings','/calendars/one/access']){
    const result=await request(app).get('/admin/api'+path).set('Cookie','commons-admin-dev=shared-organizer-secret').set('Authorization','Bearer shared-organizer-secret').expect(401);
    assert.doesNotMatch(result.text,/backend-secret|shared-organizer-secret/);
  }
});
test('password login creates a secure cookie and directory excludes tokens while access includes full scope',async()=>{
  const {app,auth}=setup();const response=await login(app).expect(200), token=cookie(response);
  assert.match(response.headers['set-cookie'][0],/^__Host-commons-admin=/);
  for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=7200'])assert.ok(response.headers['set-cookie'][0].includes(flag));
  assert.equal(response.body.authenticated,true);assert.equal(auth.sessions.size,1);
  assert.ok(![...auth.sessions.keys()].includes(token.split('=')[1]));
  const list=await request(app).get('/admin/api/calendars').set('Cookie',token).expect(200);
  assert.equal(list.headers['cache-control'],'no-store');assert.equal(list.body.calendars[0].scopeCount,2);assert.doesNotMatch(list.text,/secret|password|workspacePath/);
  const access=await request(app).get('/admin/api/calendars/one/access').set('Cookie',token).expect(200);
  assert.equal(access.body.workspacePath,'/o/shared-organizer-secret/');assert.deepEqual(access.body.scope.map(c=>c.id),['one','two']);assert.doesNotMatch(access.text,/backend-secret|unrelated-secret/);
  await request(app).get('/admin/api/calendars/missing/access').set('Cookie',token).expect(404);
  assert.equal((await request(app).get('/admin/api/settings').set('Cookie',token)).body.sessionHours,2);
});
test('login and logout enforce same-origin JSON and invalid passwords never create a session',async()=>{
  const {app}=setup();for(const value of [null,'https://evil.example']){
    const req=request(app).post('/admin/api/login');if(value)req.set('Origin',value);await req.send({password}).expect(403);
  }
  await request(app).post('/admin/api/login').set('Origin',origin).type('form').send({password}).expect(415);
  const bad=await request(app).post('/admin/api/login').set('Origin',origin).send({password:'wrong'}).expect(401);assert.equal(bad.headers['set-cookie'],undefined);
  const token=cookie(await login(app));
  await request(app).post('/admin/api/logout').set('Cookie',token).set('Origin','https://evil.example').send({}).expect(403);
  await request(app).get('/admin/api/calendars').set('Cookie',token).expect(200);
  await request(app).post('/admin/api/logout').set('Cookie',token).set('Origin',origin).send({}).expect(204);
  await request(app).get('/admin/api/calendars').set('Cookie',token).expect(401);
});
test('session rotation, expiration, restart and forged cookies cannot retain admin access',async()=>{
  let now=1000;const {app}=setup({now:()=>now,lifetimeMs:1000});const first=cookie(await login(app));
  const second=cookie(await login(app).set('Cookie',first));assert.notEqual(first,second);
  await request(app).get('/admin/api/calendars').set('Cookie',first).expect(401);
  await request(app).get('/admin/api/calendars').set('Cookie',second+'; '+second).expect(401);
  await request(app).get('/admin/api/calendars').set('Cookie','__Host-commons-admin='+'A'.repeat(43)).expect(401);
  now=2000;await request(app).get('/admin/api/calendars').set('Cookie',second).expect(401);
  const fresh=setup();await request(fresh.app).get('/admin/api/calendars').set('Cookie',second).expect(401);
});
test('instance login throttling does not trust forwarded IP headers and hashing concurrency is bounded',async()=>{
  const {app,auth}=setup();auth.verifying=true;
  await login(app).expect(429);auth.verifying=false;
  for(let i=0;i<9;i++)await request(app).post('/admin/api/login').set('Origin',origin).set('X-Forwarded-For',`192.0.2.${i}`).send({password:null}).expect(401);
  await login(app).expect(429);
});
test('newly created calendars appear in the admin directory without requiring restart',async()=>{
  const items=calendars(),auth=new AdminAuth({passwordHash:hash,production:true});
  const app=createApp({calendars:items,adminAuth:auth,publicOrigin:origin});const token=cookie(await login(app));
  items.push({id:'new',name:'New workspace',organizerToken:'new-secret',store:new MemoryStore()});
  const list=await request(app).get('/admin/api/calendars').set('Cookie',token).expect(200);assert.equal(list.body.calendars.length,4);
  assert.equal((await request(app).get('/admin/api/calendars/new/access').set('Cookie',token)).body.workspacePath,'/o/new-secret/');
});
