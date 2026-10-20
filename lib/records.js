/**
 * MongoDB 기록 헬퍼 (DR-04, FR-10, FR-15, FR-20, BR-10)
 * 시간에 따라 계속 증가하는 이력/로그 데이터를 MongoDB에 저장한다.
 */
const mongo = require('../db/mongo');

const actorOf = (user) => (user ? { id: user.id, username: user.username, role: user.role } : { id: null, username: 'system', role: 'SYSTEM' });

/** 관리 활동 / 중요 상태 변경 감사 로그 */
async function audit(user, action, entityType, entityId, details = {}, result = 'SUCCESS', ip) {
  await mongo.col('auditLogs').insertOne({
    at: new Date(),
    actor: actorOf(user),
    action,
    entity: { type: entityType, id: entityId === undefined ? null : String(entityId) },
    details,
    result,
    ip: ip || null,
  });
}

/** 구성원 역할/소속/상태/평가 변경 이력 (BR-10) */
async function memberHistory(memberId, type, from, to, user, reason, extra = {}) {
  await mongo.col('memberHistory').insertOne({
    memberId: Number(memberId), type, from, to, reason: reason || null, by: actorOf(user), at: new Date(), ...extra,
  });
}

/** 업무 상태/배정 변경 이력 (FR-10) */
async function taskHistory(taskId, event, from, to, user, note, extra = {}) {
  await mongo.col('taskHistory').insertOne({
    taskId: Number(taskId), event, from, to, note: note || null, by: actorOf(user), at: new Date(), ...extra,
  });
}

/** 자원 사용/반환/상태 변경 이력 (FR-15) */
async function resourceHistory(resourceId, event, from, to, user, extra = {}) {
  await mongo.col('resourceHistory').insertOne({
    resourceId: Number(resourceId), event, from, to, by: actorOf(user), at: new Date(), ...extra,
  });
}

/** 구성원 활동 기록 */
async function activity(memberId, type, description, refs = {}) {
  await mongo.col('activities').insertOne({ memberId: Number(memberId), type, description, refs, source: 'SYSTEM', at: new Date() });
}

/** 알림 발송 */
async function notify(memberIds, type, title, message, link = null) {
  let ids = [...new Set([].concat(memberIds).filter(Boolean).map(Number))];
  if (!ids.length) return;
  // 수신 거부(mute) 설정한 알림 유형은 제외
  const muted = await mongo.col('notificationPrefs').find({ memberId: { $in: ids }, mutedTypes: type }).toArray();
  ids = ids.filter((id) => !muted.some((m) => m.memberId === id));
  if (!ids.length) return;
  const now = new Date();
  await mongo.col('notifications').insertMany(ids.map((memberId) => ({ memberId, type, title, message, link, read: false, createdAt: now })));
}

module.exports = { audit, memberHistory, taskHistory, resourceHistory, activity, notify, actorOf };
