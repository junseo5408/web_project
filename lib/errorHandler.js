/**
 * 전역 오류 처리기 (AR-04, AR-05, NFR-01, NFR-02, NFR-05)
 * 어떤 오류든 일관된 JSON 형태로 응답하고, 권한 거부는 감사 로그에 기록한다.
 */
const { AppError } = require('./errors');
const rec = require('./records');

const MYSQL_ERRORS = {
  ER_DUP_ENTRY: [409, 'CONFLICT', '이미 존재하는 값입니다(중복).'],
  ER_NO_REFERENCED_ROW_2: [400, 'VALIDATION_ERROR', '참조하는 대상이 존재하지 않습니다.'],
  ER_ROW_IS_REFERENCED_2: [409, 'CONFLICT', '다른 데이터가 참조하고 있어 삭제할 수 없습니다.'],
  ER_CHECK_CONSTRAINT_VIOLATED: [400, 'VALIDATION_ERROR', '데이터 제약 조건을 위반했습니다.'],
  ER_DATA_TOO_LONG: [400, 'VALIDATION_ERROR', '입력값이 너무 깁니다.'],
  ER_TRUNCATED_WRONG_VALUE: [400, 'VALIDATION_ERROR', '입력값 형식이 올바르지 않습니다.'],
};

module.exports = function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = '서버 내부 오류가 발생했습니다.';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err.type === 'entity.parse.failed') {
    status = 400; code = 'VALIDATION_ERROR'; message = '요청 본문이 올바른 JSON 형식이 아닙니다.';
  } else if (err.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = '요청 본문이 너무 큽니다.';
  } else if (MYSQL_ERRORS[err.code]) {
    [status, code, message] = MYSQL_ERRORS[err.code];
    details = { dbError: err.sqlMessage };
  } else {
    console.error('[error]', req.method, req.originalUrl, err);
  }

  if (status === 403 && req.user) {
    rec.audit(req.user, 'ACCESS_DENIED', 'api', `${req.method} ${req.originalUrl}`, { message, rule: details && details.rule }, 'DENIED', req.ip).catch(() => {});
  }

  if (res.headersSent) return;
  if (!req.originalUrl.startsWith('/api') && req.accepts('html')) {
    return res.status(status).render('error', { status, code, message, user: req.user || null });
  }
  res.status(status).json({ success: false, error: { code, message, details } });
};
