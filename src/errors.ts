export class AiTeamError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export class ValidationError extends AiTeamError {
  constructor(message: string, details?: unknown) {
    super(message, 2, details);
  }
}
