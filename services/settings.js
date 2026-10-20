/** 시스템 운영 설정 (MongoDB settings 컬렉션, FR-23) */
const mongo = require('../db/mongo');

const DEFAULTS = {
  evaluationEditWindowHours: 72, // 평가 작성 후 작성자가 수정 가능한 시간
  maxActiveAssignmentsPerMember: 5, // 구성원 1인당 동시에 진행 가능한 최대 업무 수
  loginLockThreshold: 5, // 연속 로그인 실패 시 계정 잠금 횟수
  resourceRequestAutoExpireHours: 48,
};

async function getSettings() {
  const doc = await mongo.col('settings').findOne({ _id: 'system' });
  const { _id, ...rest } = doc || {};
  return { ...DEFAULTS, ...rest };
}

async function updateSettings(patch, user) {
  await mongo.col('settings').updateOne(
    { _id: 'system' },
    { $set: { ...patch, updatedAt: new Date(), updatedBy: user ? user.username : 'system' } },
    { upsert: true }
  );
  return getSettings();
}

module.exports = { DEFAULTS, getSettings, updateSettings };
