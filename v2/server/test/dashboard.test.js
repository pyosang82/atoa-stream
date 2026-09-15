const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {channelMetrics}=require('../src/dashboard');

test('channel metrics use real contributions, preserve channel scope and distinguish missing end times',()=>{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE broadcasts(broadcast_id TEXT,agent_id TEXT,started_at INTEGER,ended_at INTEGER,peak_viewers INTEGER,message_count INTEGER);
    CREATE TABLE messages(broadcast_id TEXT,role TEXT);`);
  const now=Date.parse('2026-09-15T15:05:00Z');
  const insert=db.prepare('INSERT INTO broadcasts VALUES(?,?,?,?,?,?)');
  insert.run('ended','a',now-10*60_000,now-8*60_000,3,99);
  insert.run('live','a',now-60_000,null,2,99);
  insert.run('orphan','a',now-86400_000,null,0,99);
  insert.run('other','b',now-60_000,now,80,999);
  const message=db.prepare('INSERT INTO messages VALUES(?,?)');
  for(const [id,role] of [['ended','host'],['ended','viewer'],['ended','system'],['live','host'],['other','host']])message.run(id,role);
  const r=channelMetrics(db,'a',{now,liveBroadcastId:'live'});
  assert.equal(r.totals.messages,3); assert.equal(r.totals.hostMessages,2); assert.equal(r.totals.audienceMessages,1);
  assert.equal(r.totals.broadcasts,3); assert.equal(r.totals.airtimeMs,180_000); assert.equal(r.totals.unknownEndTimes,1);
  assert.equal(r.totals.peakViewers,3); assert.equal(r.messageCounts.ended,2); assert.equal(r.messageCounts.other,undefined);
  assert.equal(r.daily.length,30); assert.equal(r.daily.at(-1).day,'2026-09-16');
  assert.equal(r.daily.at(-1).broadcasts,1); assert.equal(r.daily.at(-2).broadcasts,2);
  assert.equal(r.generatedAt,now); db.close();
});

test('a channel with no hosted broadcasts returns observed zeros and the actual KST date range',()=>{
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE broadcasts(broadcast_id TEXT,agent_id TEXT,started_at INTEGER,ended_at INTEGER,peak_viewers INTEGER);
    CREATE TABLE messages(broadcast_id TEXT,role TEXT);`);
  const r=channelMetrics(db,'absent',{now:Date.parse('2026-09-16T00:00:00Z')});
  assert.equal(r.totals.messages,0); assert.equal(r.totals.airtimeMs,0);
  assert.equal(r.daily[0].day,'2026-08-18'); assert.equal(r.daily.at(-1).day,'2026-09-16');
  db.close();
});
