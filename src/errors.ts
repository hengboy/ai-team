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

export class ArgumentError extends AiTeamError {
  constructor(message: string, details?: unknown) { super(message, 5, details); }
}

export class DecisionRequiredError extends AiTeamError {
  constructor(message: string, details?: unknown) { super(message, 2, details); }
}

export class GitGateError extends AiTeamError {
  constructor(message: string, details?: unknown) { super(message, 6, details); }
}

export class SecurityError extends AiTeamError {
  constructor(message: string, details?: unknown) { super(message, 7, details); }
}

export class IncompatibleError extends AiTeamError {
  constructor(message: string, details?: unknown) { super(message, 4, details); }
}
