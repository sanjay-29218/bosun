/**
 * The manager-instructions tools act only for a standing thread itself. Kept apart from the
 * toolkit so the Claude adapter can deny them to native subagents without importing its services.
 */
export const READ_MANAGER_INSTRUCTIONS = "crew_read_manager_instructions";
export const UPDATE_MANAGER_INSTRUCTIONS = "crew_update_manager_instructions";
export const MANAGER_INSTRUCTIONS_TOOLS = [
  READ_MANAGER_INSTRUCTIONS,
  UPDATE_MANAGER_INSTRUCTIONS,
] as const;
