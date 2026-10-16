import { AnswerValidator } from "./answer-validator.js";
import { ProcessValidator } from "./process-validator.js";
import { ResultValidator } from "./result-validator.js";

export type DeliveryValidationBundle = [
  ResultValidator,
  ProcessValidator,
  AnswerValidator,
];

export function createDeliveryValidatorBundle(): DeliveryValidationBundle {
  return [
    new ResultValidator(),
    new ProcessValidator(),
    new AnswerValidator(),
  ];
}
