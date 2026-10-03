import { BOT_TURN_STATE, type BotTurnState } from "@t3tools/contracts";

export const botTurnStateFromStatus = (status: string): BotTurnState => {
  switch (status) {
    case "running":
    case "waiting":
      return BOT_TURN_STATE.RUNNING;
    case "completed":
      return BOT_TURN_STATE.COMPLETED;
    case "failed":
      return BOT_TURN_STATE.ERROR;
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return BOT_TURN_STATE.INTERRUPTED;
    default:
      return BOT_TURN_STATE.PENDING;
  }
};
