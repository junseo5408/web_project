/** 평판 점수 계산 (FR-18, FR-19) : 평가 평균(5점 만점 → 100점 환산) + 평판 가감점 */
const db = require('../db/mysql');
const mongo = require('../db/mongo');

async function reputationOf(memberIds) {
  const ids = memberIds.map(Number);
  if (!ids.length) return [];
  const [evals, ledger, attendance] = await Promise.all([
    mongo.col('evaluations').aggregate([
      { $match: { memberId: { $in: ids }, status: 'ACTIVE' } },
      { $group: { _id: '$memberId', avg: { $avg: '$overall' }, count: { $sum: 1 } } },
    ]).toArray(),
    mongo.col('reputationLedger').aggregate([
      { $match: { memberId: { $in: ids } } },
      { $group: { _id: '$memberId', points: { $sum: '$points' } } },
    ]).toArray(),
    db.query(
      `SELECT a.member_id, COUNT(*) AS total, SUM(a.attendance = 'PRESENT') AS present
         FROM task_assignments a JOIN tasks t ON t.id = a.task_id
        WHERE a.member_id IN (?) AND t.status = 'COMPLETED' AND a.status = 'ACCEPTED' GROUP BY a.member_id`,
      [ids]
    ),
  ]);
  return ids.map((id) => {
    const e = evals.find((x) => x._id === id);
    const l = ledger.find((x) => x._id === id);
    const a = attendance.find((x) => x.memberId === id);
    const evaluationAverage = e ? Math.round(e.avg * 100) / 100 : null;
    const ledgerPoints = l ? l.points : 0;
    return {
      memberId: id,
      evaluationCount: e ? e.count : 0,
      evaluationAverage,
      ledgerPoints,
      completedTasks: a ? a.total : 0,
      attendanceRate: a && a.total ? Math.round((Number(a.present) / a.total) * 100) : null,
      score: Math.round((evaluationAverage || 0) * 20 + ledgerPoints),
    };
  });
}

module.exports = { reputationOf };
