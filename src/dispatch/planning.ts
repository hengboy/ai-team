import { ValidationError } from "../errors.js";

const TRANSITIONS: Record<string, string[]> = {
  planning: ["requirements"], requirements: ["requirements", "requirements_confirmed", "no_change"],
  requirements_confirmed: ["spec_ready"], spec_ready: ["plan_ready"], plan_ready: ["tasks_preview", "ready"],
  tasks_preview: ["tasks_preview", "ready"], ready: [],
};

export const assertPlanningTransition = (current: string, next: string): void => {
  if (!TRANSITIONS[current]?.includes(next)) throw new ValidationError(`invalid planning stage transition: ${current} -> ${next}`);
};

export const planningDecisionKind = (stage: string, choiceIds: string[]): { finalConfirmation: boolean; taskSplit: boolean } => ({
  finalConfirmation: stage === "requirements" && choiceIds.length === 2 && choiceIds[0] === "confirm" && choiceIds[1] === "revise",
  taskSplit: stage === "plan_ready" && choiceIds.length === 2 && choiceIds[0] === "no_split" && choiceIds[1] === "split",
});

export interface PlanningDecision {
  question: string;
  choices: Array<{ id: string; label: string; impact: string }>;
  recommendation: string;
}

export interface PlanningSubmissionIntent {
  needsDecision: boolean;
  question?: string;
  decisionType?: string;
}

export const planningSubmissionIntent = (
  stage: string,
  pendingQuestions: string[],
  decision: PlanningDecision | null,
  requirementDecisionCount: number,
): PlanningSubmissionIntent => {
  if (pendingQuestions.length && !["requirements", "plan_ready", "tasks_preview"].includes(stage)) {
    throw new ValidationError(`planning stage ${stage} cannot have pending questions`);
  }
  if (!decision) return { needsDecision: false };
  const choiceIds = decision.choices.map(({ id }) => id).sort();
  const { finalConfirmation, taskSplit } = planningDecisionKind(stage, choiceIds);
  if ((finalConfirmation || taskSplit) && pendingQuestions.length) {
    throw new ValidationError(`${finalConfirmation ? "requirements_final" : "task_split"} decision must not use functional pending_questions`);
  }
  if (stage === "plan_ready" && !taskSplit) throw new ValidationError("plan_ready decision choices must be split and no_split");
  if (stage === "tasks_preview" && (choiceIds.length !== 2 || choiceIds[0] !== "approve" || choiceIds[1] !== "revise")) {
    throw new ValidationError("task preview decision choices must be approve and revise");
  }
  const requirementQuestion = stage === "requirements" && !finalConfirmation;
  return {
    needsDecision: true,
    question: requirementQuestion
      ? `问题 ${requirementDecisionCount + 1}、${decision.question.replace(/^问题\s*\d+、\s*/, "")}`
      : decision.question,
    decisionType: requirementQuestion ? "requirement" : finalConfirmation ? "requirements_final" : taskSplit ? "task_split" : stage === "tasks_preview" ? "task_preview" : "workflow",
  };
};

export const planningContinuationPacket = (stage: string) => ({
  objective: "Continue the planning workflow from the current stage, asking at most one highest-priority question.",
  allowed_read_paths: ["package.json"],
  allowed_write_paths: [".ai-team/plans/**"],
  acceptance_criteria: ["Return the next planning stage", "Return at most one pending question"],
  context: { stage },
});
