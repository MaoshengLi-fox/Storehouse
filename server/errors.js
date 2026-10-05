// Maps thrown errors to HTTP responses.
// Business rules throw plain `Error` with a Chinese message meant for the user (400).
// Code can throw HttpError to pick another status (401/403/404/409/429).
// Anything else (TypeError, database faults…) is an internal error: logged, and
// the client only gets a generic message so server internals are not leaked.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function errorResponse(error) {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
    return { status: 409, message: '数据重复或存在关联记录，无法保存，请刷新后核对' };
  }
  if (error && error.constructor === Error && error.message) return { status: 400, message: error.message };
  return { status: 500, message: '服务器内部错误，请稍后重试；如持续出现请联系管理员' };
}
