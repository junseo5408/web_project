/**
 * 주기적 운영 작업
 *  - 오래된 자원 사용 요청 자동 만료 (설정: resourceRequestAutoExpireHours, 또는 사용 시작 시각 경과)
 *  - 종료된 회의 자동 완료 처리
 *  - 반납 기한이 지난 자원 사용자에게 1회 알림
 */
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const rec = require('../lib/records');
const { getSettings } = require('./settings');

async function expireResourceRequests() {
  const { resourceRequestAutoExpireHours } = await getSettings();
  const rows = await db.query(
    `SELECT q.id, q.requester_id, r.name FROM resource_requests q JOIN resources r ON r.id = q.resource_id
      WHERE q.status = 'PENDING' AND (q.created_at < DATE_SUB(NOW(), INTERVAL ? HOUR) OR q.start_at < NOW())`,
    [resourceRequestAutoExpireHours]
  );
  for (const q of rows) {
    await db.query("UPDATE resource_requests SET status = 'CANCELLED', review_comment = '처리 기한 경과로 자동 만료', reviewed_at = NOW() WHERE id = ? AND status = 'PENDING'", [q.id]);
    await rec.notify(q.requesterId, 'REQUEST_REVIEWED', '자원 요청 만료', `${q.name} 사용 요청이 처리 기한 경과로 자동 만료되었습니다.`);
  }
  return rows.length;
}

async function closeFinishedMeetings() {
  const r = await db.query("UPDATE meetings SET status = 'DONE' WHERE status = 'SCHEDULED' AND end_at < NOW()");
  return r.affectedRows;
}

async function notifyOverdueReturns() {
  const rows = await db.query(
    `SELECT a.id, a.member_id, a.task_id, r.name FROM resource_allocations a JOIN resources r ON r.id = a.resource_id
      WHERE a.status = 'IN_USE' AND a.end_at < NOW()`
  );
  let sent = 0;
  for (const a of rows) {
    const key = `overdue:${a.id}`;
    const already = await mongo.col('notifications').findOne({ dedupeKey: key });
    if (already) continue;
    let targets = a.memberId ? [a.memberId] : [];
    if (a.taskId) {
      const t = await db.query("SELECT member_id FROM task_assignments WHERE task_id = ? AND status IN ('ASSIGNED','ACCEPTED')", [a.taskId]);
      targets = targets.concat(t.map((x) => x.memberId));
    }
    for (const m of [...new Set(targets)]) {
      await mongo.col('notifications').insertOne({
        memberId: m, type: 'RESOURCE', title: '자원 반납 기한 경과', message: `${a.name} 의 반납 기한이 지났습니다. 반납 처리해 주세요.`,
        link: `/allocations`, read: false, createdAt: new Date(), dedupeKey: key,
      });
      sent += 1;
    }
  }
  return sent;
}

async function runAll() {
  try {
    const [expired, closed, overdue] = [await expireResourceRequests(), await closeFinishedMeetings(), await notifyOverdueReturns()];
    if (expired || closed || overdue) console.log(`[jobs] 만료 요청 ${expired}건, 완료 회의 ${closed}건, 반납 지연 알림 ${overdue}건`);
  } catch (e) {
    console.error('[jobs] 실패:', e.message);
  }
}

function start(intervalMs = 5 * 60 * 1000) {
  setTimeout(runAll, 10 * 1000).unref();
  return setInterval(runAll, intervalMs).unref();
}

module.exports = { start, runAll, expireResourceRequests, closeFinishedMeetings, notifyOverdueReturns };
