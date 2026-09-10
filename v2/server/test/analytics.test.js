const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-analytics-'));
process.env.PULSAR_DATA_DIR = temp;
const analytics = require('../src/analytics');
const db = new Database(path.join(temp, 'analytics.db'));
const req = (ip, ua = 'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36') => ({ socket: { remoteAddress: ip }, headers: { 'user-agent': ua } });
const visit = (key, request, route = '/join') => analytics.logEvents(key, { events: [{event:'page_view',route,sessionId:key}] }, request);
beforeEach(() => db.exec("DELETE FROM events; DELETE FROM hits; DELETE FROM meta WHERE k IN ('owner_keys','owner_networks')"));
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('admin browser and network are removed retroactively; new browsers on the owner network stay excluded', () => {
  const home = req('203.0.113.10'), work = req('203.0.113.20');
  visit('home-old', home); visit('work-old', work); visit('external', req('203.0.113.30'));
  analytics.markOwnerRequest(home, 'home-old'); analytics.markOwnerRequest(work, 'work-old');
  visit('home-fresh-cookie', home); visit('work-fresh-cookie', work);
  assert.equal(analytics.overview(1).totals.visitors, 1);
  assert.equal(analytics.overview(1, {excludeSelf:false}).totals.visitors, 5);
  assert.ok(analytics.getOwnerKeys().includes('home-fresh-cookie'));
  assert.equal(analytics.content(1, {channels:[]}).routes[0].views, 1);
});

test('beacon request context overrides claimed data; bots, local and unknown history do not become external visitors', () => {
  visit('real-browser', req('203.0.113.30'));
  visit('headless', req('203.0.113.31','HeadlessChrome/151'));
  visit('scanner', req('203.0.113.32','AppEngine-Google virustotalcloud'));
  visit('local', req('127.0.0.1'));
  visit('legacy', undefined);
  analytics.logEvents('spoofed', {ip_hash:'pretend',is_bot:0,events:[{event:'page_view',route:'/join'}]}, req('203.0.113.40','node'));
  const result=analytics.overview(1);
  assert.equal(result.totals.visitors,1);
  assert.deepEqual(result.unclassified,{browsers:1,pageviews:1});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n,6);
});

test('campaign and guide counts apply the same owner and bot filters', () => {
  const home=req('203.0.113.10'), guest=req('203.0.113.11');
  analytics.markOwnerRequest(home,'owner');
  for(const [key,request] of [['owner',home],['new-owner',home],['guest',guest],['bot',req('203.0.113.12','Orbit-MCP-Registry-IconResolver/1.0')]]) {
    analytics.logHit(request,new URL('https://pulsarsignal.live/guide?utm_source=youtube&utm_campaign=first100'),key,200,1);
  }
  assert.equal(analytics.overview(1).guideHits,1);
  assert.equal(analytics.acquisition(1).utm[0].hits,1);
});

test('realtime connections honor owner exclusion and reject unclassified sockets', () => {
  const home=req('203.0.113.10'), guest=req('203.0.113.11'), bot=req('203.0.113.12','HeadlessChrome');
  analytics.markOwnerRequest(home,'owner');
  visit('owner',home); visit('guest',guest); visit('bot',bot);
  const state={webClients:new Map([
    [{_traffic:analytics.trafficContext(home)},{viewerKey:'fresh-owner',subscribedRoom:'room'}],
    [{_traffic:analytics.trafficContext(guest)},{viewerKey:'guest',subscribedRoom:'room'}],
    [{_traffic:analytics.trafficContext(bot)},{viewerKey:'bot',subscribedRoom:'room'}],
    [{},{viewerKey:'unknown',subscribedRoom:'room'}]
  ])};
  assert.deepEqual(analytics.realtime(state),{connectedWeb:1,activeLast5m:1,watchingByRoom:{room:1}});
  assert.equal(analytics.realtime(state,{excludeSelf:false}).connectedWeb,2);
});
