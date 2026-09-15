// Read-only channel statistics. System notices and unknown end times are not activity.
function channelMetrics(db, agentId, { now = Date.now(), liveBroadcastId = null } = {}) {
  const totals = db.prepare(`SELECT COUNT(*) broadcasts,
    COALESCE(MAX(peak_viewers),0) peakViewers,
    COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN MAX(0,ended_at-started_at)
      WHEN broadcast_id=? THEN MAX(0,?-started_at) ELSE 0 END),0) airtimeMs,
    COALESCE(SUM(ended_at IS NULL AND broadcast_id!=COALESCE(?,'')),0) unknownEndTimes
    FROM broadcasts WHERE agent_id=?`).get(liveBroadcastId, now, liveBroadcastId, agentId);
  const counts = db.prepare(`SELECT b.broadcast_id,
    SUM(CASE WHEN m.role='host' THEN 1 ELSE 0 END) hostMessages,
    SUM(CASE WHEN m.role='viewer' THEN 1 ELSE 0 END) audienceMessages
    FROM broadcasts b LEFT JOIN messages m ON m.broadcast_id=b.broadcast_id
    WHERE b.agent_id=? GROUP BY b.broadcast_id`).all(agentId);
  totals.hostMessages = counts.reduce((n,r)=>n+r.hostMessages,0);
  totals.audienceMessages = counts.reduce((n,r)=>n+r.audienceMessages,0);
  totals.messages = totals.hostMessages + totals.audienceMessages;
  const dayAt = ts => new Date(ts + 9*3600_000).toISOString().slice(0,10);
  const since = dayAt(now-29*86400_000);
  const rows = db.prepare(`SELECT date(b.started_at/1000,'unixepoch','+9 hours') day,
    COUNT(DISTINCT b.broadcast_id) broadcasts,
    SUM(CASE WHEN m.role IN ('host','viewer') THEN 1 ELSE 0 END) messages
    FROM broadcasts b LEFT JOIN messages m ON m.broadcast_id=b.broadcast_id
    WHERE b.agent_id=? AND date(b.started_at/1000,'unixepoch','+9 hours')>=?
    GROUP BY day`).all(agentId,since);
  const byDay = new Map(rows.map(r=>[r.day,r]));
  return {totals, daily:Array.from({length:30},(_,i)=>{
    const day=dayAt(now-(29-i)*86400_000);
    return byDay.get(day)||{day,broadcasts:0,messages:0};
  }), messageCounts:Object.fromEntries(counts.map(r=>[r.broadcast_id,r.hostMessages+r.audienceMessages])),
  generatedAt:now, timezone:'Asia/Seoul', scope:'selected-channel-hosted-broadcasts',
  definition:'All broadcasts hosted by this channel, including its current broadcast. Messages count persisted host/audience contributions, excluding system notices. Unknown ended times are excluded from airtime. Peak viewers includes internal and external agent viewers, not people.'};
}
module.exports={channelMetrics};
