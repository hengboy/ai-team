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

export interface ValidationCause {
  message: string;
  issues: Array<{ pointer: string; constraint: string; message: string; suggestion: string }>;
}

export const validationCause = (error: unknown): ValidationCause => {
  const failure = error instanceof AiTeamError ? error : new ValidationError(error instanceof Error ? error.message : String(error));
  const details = Array.isArray(failure.details) ? failure.details : failure.details ? [failure.details] : [];
  const issues = details.map((detail) => {
    const value = detail && typeof detail === "object" && !Array.isArray(detail) ? detail as Record<string, unknown> : {};
    const pointer = typeof value.pointer === "string" ? value.pointer : "/";
    const constraint = typeof value.constraint === "string" ? value.constraint : "validation";
    const message = typeof value.message === "string" ? value.message : failure.message;
    const suggestion = typeof value.suggestion === "string" ? value.suggestion : `Correct ${pointer} to satisfy ${constraint}, then validate the same staging entry again.`;
    return { pointer, constraint, message, suggestion };
  });
  return { message: failure.message, issues: issues.length ? issues : [{ pointer: "/", constraint: "validation", message: failure.message, suggestion: "Correct the reported input and validate the same staging entry again." }] };
};

export class IncompatibleError extends AiTeamError {
  constructor(message: string, details?: unknown) {
    const context = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : { context: details };
    super(message, 4, {
      ...context,
      reason_code: typeof context.reason_code === "string" ? context.reason_code : "incompatible_input",
      next_action: typeof context.next_action === "string" ? context.next_action : "reset",
    });
  }
}
