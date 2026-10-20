const { MongoClient, ObjectId } = require('mongodb');
const config = require('../config');

let client;
let db;

/** MongoDB 컬렉션 목록 (DR-04: 시간에 따라 계속 증가하거나 구조가 유연한 데이터) */
const COLLECTIONS = {
  auditLogs: 'audit_logs', // 관리 활동/중요 상태 변경 감사 기록 (FR-20)
  memberHistory: 'member_history', // 역할/소속/상태/평가 변경 이력 (BR-10)
  taskHistory: 'task_history', // 업무 상태/배정 변경 이력 (FR-10)
  resourceHistory: 'resource_history', // 자원 사용/반환/상태 변경 이력 (FR-15)
  evaluations: 'evaluations', // 평가 기록 (FR-18)
  evaluationCriteria: 'evaluation_criteria',
  reputationLedger: 'reputation_ledger', // 평판 가감점 원장
  activities: 'activities', // 구성원 활동 기록
  taskComments: 'task_comments',
  taskChecklists: 'task_checklists',
  taskTemplates: 'task_templates',
  announcements: 'crew_announcements',
  notifications: 'notifications',
  loginHistory: 'login_history',
  revokedTokens: 'revoked_tokens',
  settings: 'settings',
  savedFilters: 'saved_filters',
  notificationPrefs: 'notification_prefs',
  meetingMinutes: 'meeting_minutes',
};

async function connect() {
  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(config.mongo.dbName);
  await ensureIndexes();
  return db;
}

async function ensureIndexes() {
  const c = COLLECTIONS;
  await Promise.all([
    db.collection(c.auditLogs).createIndex({ at: -1 }),
    db.collection(c.auditLogs).createIndex({ 'entity.type': 1, 'entity.id': 1 }),
    db.collection(c.memberHistory).createIndex({ memberId: 1, at: -1 }),
    db.collection(c.taskHistory).createIndex({ taskId: 1, at: -1 }),
    db.collection(c.resourceHistory).createIndex({ resourceId: 1, at: -1 }),
    db.collection(c.evaluations).createIndex({ memberId: 1, createdAt: -1 }),
    db.collection(c.reputationLedger).createIndex({ memberId: 1, at: -1 }),
    db.collection(c.activities).createIndex({ memberId: 1, at: -1 }),
    db.collection(c.taskComments).createIndex({ taskId: 1, createdAt: 1 }),
    db.collection(c.taskChecklists).createIndex({ taskId: 1 }, { unique: true }),
    db.collection(c.notifications).createIndex({ memberId: 1, createdAt: -1 }),
    db.collection(c.loginHistory).createIndex({ at: -1 }),
    db.collection(c.revokedTokens).createIndex({ jti: 1 }, { unique: true }),
    db.collection(c.revokedTokens).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection(c.savedFilters).createIndex({ memberId: 1 }),
    db.collection(c.notificationPrefs).createIndex({ memberId: 1 }, { unique: true }),
    db.collection(c.meetingMinutes).createIndex({ meetingId: 1 }, { unique: true }),
  ]);
}

const col = (name) => db.collection(COLLECTIONS[name] || name);
const getDb = () => db;
const close = () => (client ? client.close() : Promise.resolve());
const oid = (id) => new ObjectId(String(id));

/** Mongo 문서의 _id 를 id(string) 로 변환 */
const out = (doc) => {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
};

module.exports = { connect, close, col, getDb, oid, out, COLLECTIONS, ObjectId };
