export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function check(condition, status, code, message) {
  if (!condition) throw new AppError(status, code, message);
}
