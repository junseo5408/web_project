/** 모든 REST API 라우트 모듈 등록 (등록 순서 = API 번호 순서) */
const ROUTES = [
  'auth', 'me', 'roles', 'members', 'promotions', 'discipline', 'crews', 'regions', 'joinRequests', 'announcements',
  'tasks', 'assignments', 'taskCollab', 'templates', 'meetings',
  'resources', 'resourceTypes', 'allocations', 'resourceRequests', 'resourceIssues',
  'evaluations', 'activities', 'search', 'stats', 'audit', 'admin',
];

module.exports = function registerRoutes(app) {
  for (const name of ROUTES) require(`./${name}`)(app);
};
