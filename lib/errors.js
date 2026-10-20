/**
 * 서비스 전반에서 사용하는 공통 오류 타입 (AR-04, AR-05, NFR-05)
 * 모든 오류는 { success:false, error:{ code, message, details } } 형태로 응답된다.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = {
  AppError,
  badRequest: (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthorized: (message = '인증이 필요합니다.') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = '이 작업을 수행할 권한이 없습니다.', rule = 'BR-09') =>
    new AppError(403, 'FORBIDDEN', message, { rule }),
  notFound: (entity, id) =>
    new AppError(404, 'NOT_FOUND', `${entity}(id=${id})을(를) 찾을 수 없습니다.`, { entity, id }),
  conflict: (message, details) => new AppError(409, 'CONFLICT', message, details),
  // 업무 규칙(BR-xx) 위반
  rule: (rule, message, details = {}) =>
    new AppError(409, 'BUSINESS_RULE_VIOLATION', message, { rule, ...details }),
  // 현재 상태에서 허용되지 않는 상태 전이/작업
  state: (message, details) => new AppError(422, 'INVALID_STATE', message, details),
};
