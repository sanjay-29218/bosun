import { CREW_TURN_STATE, type CrewTurnState } from "@t3tools/contracts";

export const crewTurnStateFromStatus = (status: string): CrewTurnState => {
  switch (status) {
    case "running":
    case "waiting":
      return CREW_TURN_STATE.RUNNING;
    case "completed":
      return CREW_TURN_STATE.COMPLETED;
    case "failed":
      return CREW_TURN_STATE.ERROR;
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return CREW_TURN_STATE.INTERRUPTED;
    default:
      return CREW_TURN_STATE.PENDING;
  }
};
